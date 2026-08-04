import type Database from 'better-sqlite3'
import { simpleGit } from 'simple-git'
import { getTask, updateTask } from '../state/tasks.js'
import type { Task } from '../state/tasks.js'
import { getAgent, updateAgent } from '../state/agents.js'
import { ensureIntegrationBranch, mergeWorktreeBranch, MergeConflictError, isMergedInto } from '../../git/merge.js'
import { removeWorktree } from '../../git/worktree.js'
import { calculateCost } from '../cost.js'
import { killTmuxWindow } from '../../spawner/tmux.js'

export function handleGetMyTask(db: Database.Database, agentId: string): Task {
  const task = db.prepare(
    "SELECT * FROM tasks WHERE agent_id = ? AND status = 'in_progress'"
  ).get(agentId) as Task | undefined
  if (!task) throw new Error(`No in-progress task found for agent ${agentId}`)

  // Mark agent as running now that it has acknowledged its task
  updateAgent(db, agentId, { status: 'running' })

  return task
}

export function handleReportProgress(
  db: Database.Database,
  agentId: string,
  taskId: string,
  message: string
): void {
  db.prepare(
    'INSERT INTO logs (task_id, agent_id, level, message) VALUES (?, ?, ?, ?)'
  ).run(taskId, agentId, 'info', message)
}

export async function handleReportDone(
  db: Database.Database,
  taskId: string,
  summary: string,
  opts: { input_tokens?: number; output_tokens?: number; total_tokens?: number; duration_seconds?: number; model?: string } = {}
): Promise<void> {
  const task = getTask(db, taskId)
  const duration_seconds = opts.duration_seconds ?? (task?.started_at
    ? (Date.now() - new Date(task.started_at).getTime()) / 1000
    : undefined)

  const model = opts.model ?? task?.model ?? 'sonnet'
  const cost_usd = (opts.input_tokens != null && opts.output_tokens != null)
    ? calculateCost(opts.input_tokens, opts.output_tokens, model)
    : undefined

  // Tracks whether task branch landed on the run integration branch. null = no merge attempted.
  let mergedIntoRun: boolean | null = null

  // Merge worktree branch into mc/integration and remove worktree if one was created
  if (task?.worktree_path && task.branch) {
    const projectCwd = task.repo_path ?? (task.run_id
      ? (db.prepare('SELECT p.cwd FROM projects p JOIN runs r ON r.project_id = p.id WHERE r.id = ?').get(task.run_id) as { cwd: string } | undefined)?.cwd
      : undefined)
    if (projectCwd) {
      // Detect zero-commit branch: compare current HEAD to the SHA at worktree creation
      if (task.head_sha) {
        try {
          const git = simpleGit(projectCwd)
          const currentSha = (await git.revparse([task.branch])).trim()
          if (currentSha === task.head_sha) {
            const reason = 'task branch has no commits'
            db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
              taskId, 'error', `Empty branch: ${task.branch} has no commits since creation (head_sha=${task.head_sha})`
            )
            await removeWorktree(projectCwd, { path: task.worktree_path, branch: task.branch })
              .catch(() => {})
            updateTask(db, taskId, { status: 'failed', failure_reason: reason })
            if (task.agent_id) {
              updateAgent(db, task.agent_id, { status: 'done' })
              const agent = getAgent(db, task.agent_id)
              if (agent?.tmux_pane) killTmuxWindow(agent.tmux_pane)
            }
            return
          }
        } catch {
          // If rev-parse fails (branch gone?), fall through to normal merge which will surface the real error
        }
      }
      const runId = task.run_id ?? undefined
      const integBranch = runId ? `mc/run-${runId}` : 'mc/integration'

      // Tightly-scoped merge block — only the merge itself, never cleanup.
      // Keeping removeWorktree outside ensures a cleanup error cannot be
      // misattributed as "merge failed" and block downstream DAG tasks.
      try {
        await ensureIntegrationBranch(projectCwd, runId)
        await mergeWorktreeBranch(projectCwd, task.branch, runId, task.worktree_path)
        mergedIntoRun = true
        db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
          taskId, 'info', `Merged and pushed ${task.branch} to origin/${integBranch}`
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)

        // Before marking failed, verify the merge didn't actually land.
        // Guards against errors thrown inside mergeWorktreeBranch after the
        // merge commit was made (e.g. push errors) causing false failures.
        let landed = false
        try {
          landed = await isMergedInto(projectCwd, task.branch, integBranch)
        } catch { /* conservative: assume not landed */ }

        mergedIntoRun = landed

        if (landed) {
          // Merge landed; error came from post-merge code inside mergeWorktreeBranch.
          // Log it as a non-fatal warning and fall through to mark the task done.
          db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
            taskId, 'warn', `post_merge_cleanup_failed: ${msg}`
          )
        } else if (err instanceof MergeConflictError) {
          // Conflict path: task work is committed on the branch — do NOT remove
          // worktree/branch so the orchestrator and user can inspect/resolve it.
          // failure_reason='merge_conflict' lets the orchestrator take targeted action.
          db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
            taskId, 'error', `Merge conflict: ${task.branch} cannot be merged into ${integBranch} — conflicted files: ${err.conflictedFiles.join(', ')}`
          )
          updateTask(db, taskId, {
            status: 'failed',
            failure_reason: 'merge_conflict',
            failure_detail: err.message,
            conflicted_files: err.conflictedFiles,
            conflict_branch: integBranch,
          })
          if (task.agent_id) {
            updateAgent(db, task.agent_id, { status: 'done' })
            const agent = getAgent(db, task.agent_id)
            if (agent?.tmux_pane) killTmuxWindow(agent.tmux_pane)
          }
          return
        } else {
          // Genuine merge failure — mark the task failed.
          db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
            taskId, 'error', `Merge failed: ${task.branch} could not be merged — ${msg}`
          )
          // Clean up the worktree so retries can recreate it with the same branch name
          await removeWorktree(projectCwd, { path: task.worktree_path, branch: task.branch })
            .catch(() => {}) // best-effort; don't mask the original merge error
          updateTask(db, taskId, { status: 'failed', failure_reason: 'merge failed' })
          if (task.agent_id) {
            updateAgent(db, task.agent_id, { status: 'done' })
            const agent = getAgent(db, task.agent_id)
            if (agent?.tmux_pane) killTmuxWindow(agent.tmux_pane)
          }
          return
        }
      }

      // Post-merge cleanup — outside the merge try/catch so a cleanup error
      // never sets failure_reason "merge failed". Non-fatal: log and continue.
      await removeWorktree(projectCwd, { path: task.worktree_path, branch: task.branch })
        .catch((cleanupErr: unknown) => {
          const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
            taskId, 'warn', `post_merge_cleanup_failed: ${msg}`
          )
        })
    }
  }
  updateTask(db, taskId, {
    status: 'done',
    duration_seconds,
    input_tokens: opts.input_tokens,
    output_tokens: opts.output_tokens,
    total_tokens: opts.total_tokens,
    cost_usd,
    ...(mergedIntoRun !== null && { merged_into_run: mergedIntoRun }),
  })
  db.prepare(
    'INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)'
  ).run(taskId, 'info', `DONE: ${summary}`)
  // Mark the agent done so the spawner watcher's exit handler doesn't flag it as failed
  if (task?.agent_id) {
    updateAgent(db, task.agent_id, { status: 'done' })
    // Reap the tmux window now that the task is complete
    const agent = getAgent(db, task.agent_id)
    if (agent?.tmux_pane) killTmuxWindow(agent.tmux_pane)
  }
}

export function handleReportBlocked(
  db: Database.Database,
  taskId: string,
  reason: string,
  errorContext: string
): { action: 'retry' | 'escalate' } {
  const task = getTask(db, taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  db.prepare(
    'INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)'
  ).run(taskId, 'warn', `BLOCKED: ${reason}\n${errorContext}`)

  if (task.retry_count < task.max_retries) {
    updateTask(db, taskId, { retry_count: task.retry_count + 1 })
    return { action: 'retry' }
  }

  updateTask(db, taskId, { status: 'failed' })
  return { action: 'escalate' }
}
