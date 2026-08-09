import path from 'path'
import { simpleGit } from 'simple-git'
import type Database from 'better-sqlite3'
import { createTask, listTasks, getTask, updateTask } from '../state/tasks.js'
import type { Task } from '../state/tasks.js'
import { addEdge, getReadyTasks, getBlockers } from '../state/dag.js'
import { getAgent, listAgents, registerAgent, updateAgent } from '../state/agents.js'
import { upsertProject, listProjects } from '../state/projects.js'
import { createRun, getRun, listRunsWithStats, updateRun, RunWithStats } from '../state/runs.js'
import { createWorktree, preflightReconcile, isProtectedBranch, removeWorktree } from '../../git/worktree.js'
import { killTmuxWindow, reapStaleWindows, ensureTmuxSession } from '../../spawner/tmux.js'
import { hasRemote, getRemoteUrl, parseGitHubRemote, pushBranch, getBranchSyncState, isMainCheckout } from '../../git/ops.js'
import type { PushResult } from '../../git/ops.js'
import { createPullRequest } from '../../git/pr.js'
import type { PrResult } from '../../git/pr.js'
import { ensureIntegrationBranch, mergeWorktreeBranch, isAutoResolvable, RUN_INTEGRATION_BRANCH, MergeConflictError, isMergedInto } from '../../git/merge.js'

export const VALID_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortValue = typeof VALID_EFFORT_VALUES[number]

/**
 * Normalise an effort string to a canonical EffortValue.
 * Returns the canonical value, or null when the input is invalid.
 * "extra" is accepted as a legacy alias for "xhigh".
 */
export function normalizeEffort(effort: string): EffortValue | null {
  if (effort === 'extra') return 'xhigh'
  if ((VALID_EFFORT_VALUES as readonly string[]).includes(effort)) return effort as EffortValue
  return null
}

export interface EpicTask {
  id: string
  title: string
  description?: string
  model?: string
  effort?: string
  ticket?: string
  dependsOn: string[]
}

export interface Epic {
  tasks: EpicTask[]
  run_id?: string
  cwd?: string
}

export function handlePlanDag(
  db: Database.Database,
  epic: Epic
): { visualization: string } | { error: string } {
  let run_id = epic.run_id
  if (run_id !== undefined) {
    const run = getRun(db, run_id)
    if (!run) {
      return { error: `run_id '${run_id}' not found` }
    }
  } else if (epic.cwd) {
    const name = path.basename(epic.cwd) || epic.cwd
    const project = upsertProject(db, { name, cwd: epic.cwd })
    const title = epic.tasks[0]?.title ?? 'Unnamed run'
    const run = createRun(db, { project_id: project.id, title })
    run_id = run.id
  }
  for (const t of epic.tasks) {
    let effort: string | undefined = t.effort
    if (effort !== undefined) {
      const normalized = normalizeEffort(effort)
      if (normalized === null) {
        return {
          error: `Invalid effort "${effort}" for task "${t.id}". Valid values: ${VALID_EFFORT_VALUES.join(', ')}. ("extra" is accepted as an alias for "xhigh")`,
        }
      }
      effort = normalized
    }
    createTask(db, { id: t.id, title: t.title, description: t.description, model: t.model, effort, run_id, ticket: t.ticket })
  }
  for (const t of epic.tasks) {
    for (const dep of t.dependsOn) {
      addEdge(db, dep, t.id)
    }
  }
  return { visualization: buildDagVisualization(epic) }
}

function buildDagVisualization(epic: Epic): string {
  const taskMap = new Map(epic.tasks.map(t => [t.id, t]))
  const depth = new Map<string, number>()

  function getDepth(id: string): number {
    if (depth.has(id)) return depth.get(id)!
    const task = taskMap.get(id)
    if (!task || task.dependsOn.length === 0) {
      depth.set(id, 0)
      return 0
    }
    const d = Math.max(...task.dependsOn.map(dep => getDepth(dep) + 1))
    depth.set(id, d)
    return d
  }

  for (const t of epic.tasks) getDepth(t.id)

  const waves = new Map<number, EpicTask[]>()
  for (const t of epic.tasks) {
    const d = depth.get(t.id) ?? 0
    if (!waves.has(d)) waves.set(d, [])
    waves.get(d)!.push(t)
  }

  const numWaves = waves.size
  const lines: string[] = [
    `DAG Plan — ${epic.tasks.length} task${epic.tasks.length === 1 ? '' : 's'}, ${numWaves} wave${numWaves === 1 ? '' : 's'}`,
    '',
  ]

  for (const [waveIdx, tasks] of [...waves.entries()].sort(([a], [b]) => a - b)) {
    lines.push(`Wave ${waveIdx + 1}${waveIdx === 0 ? ' (runs immediately)' : ''}`)
    for (const t of tasks) lines.push(`  [${t.id}] ${t.title}`)
    lines.push('')
  }

  const edges = epic.tasks.flatMap(t => t.dependsOn.map(dep => `  ${dep} → ${t.id}`))
  if (edges.length > 0) {
    lines.push('Dependencies')
    lines.push(...edges)
  }

  return lines.join('\n').trimEnd()
}

/** Task augmented with last_log_at so callers can distinguish working from merely registered. */
export type TaskWithActivity = Task & {
  /** ISO timestamp of the most recent log entry for this task, or null if no logs yet. */
  last_log_at: string | null
}

export interface SystemStatus {
  tasks: TaskWithActivity[]
  agents: ReturnType<typeof listAgents>
  readyTasks: ReturnType<typeof getReadyTasks>
  retriableTasks: TaskWithActivity[]
  runs: ReturnType<typeof listRunsWithStats>
}

/**
 * Enriches tasks with last_log_at from the logs table.
 * A null last_log_at means the agent has produced no log entries yet — it is
 * "merely registered" (spawning) rather than actively working.
 */
export function enrichWithLastLog(db: Database.Database, tasks: ReturnType<typeof listTasks>): TaskWithActivity[] {
  return tasks.map(task => {
    const row = db.prepare(
      'SELECT MAX(created_at) AS last_log FROM logs WHERE task_id = ?'
    ).get(task.id) as { last_log: string | null }
    return { ...task, last_log_at: row.last_log }
  })
}

export function handleGetSystemStatus(db: Database.Database, includeDone = false): SystemStatus {
  const allTasks = listTasks(db)
  const tasks = includeDone ? allTasks : allTasks.filter(t => t.status !== 'done' && t.status !== 'failed' && t.status !== 'cancelled')
  const retriableTasks = allTasks.filter(t => t.status === 'failed' && t.retry_count < t.max_retries)
  return {
    tasks: enrichWithLastLog(db, tasks),
    agents: listAgents(db),
    readyTasks: getReadyTasks(db),
    retriableTasks: enrichWithLastLog(db, retriableTasks),
    runs: listRunsWithStats(db),
  }
}

/**
 * Block until any task status changes, then return full system status.
 * Polls the DB every second server-side.
 */
export async function handleWaitForEvent(
  db: Database.Database,
  timeoutSeconds = 30,
  includeDone = true,
): Promise<SystemStatus> {
  const deadline = Date.now() + timeoutSeconds * 1000
  const snapshot = () =>
    JSON.stringify(listTasks(db).map(t => ({ id: t.id, status: t.status })))
  const initial = snapshot()

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (snapshot() !== initial) break
  }

  return handleGetSystemStatus(db, includeDone)
}

export function handleCancelTask(db: Database.Database, taskId: string): void {
  db.prepare(
    "UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?"
  ).run(taskId)
  // Reap the tmux window if one exists for this task's agent
  const task = getTask(db, taskId)
  if (task?.agent_id) {
    const agent = getAgent(db, task.agent_id)
    if (agent?.tmux_pane) killTmuxWindow(agent.tmux_pane)
  }
}

export interface CompleteTaskResult {
  ok: boolean
  merged: boolean
  reason?: string
}

export async function handleCompleteTask(
  db: Database.Database,
  taskId: string,
  summary: string
): Promise<CompleteTaskResult> {
  updateTask(db, taskId, { status: 'done' })
  db.prepare(
    'INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)'
  ).run(taskId, 'info', `DONE (orchestrator override): ${summary}`)
  const task = getTask(db, taskId)
  if (task?.agent_id) {
    updateAgent(db, task.agent_id, { status: 'done' })
  }

  // Guard: skip merge if branch, worktree_path, or repo_path is missing.
  // This happens when the worker died before the worktree was fully set up.
  const repoPath = task?.repo_path ?? (task?.run_id
    ? (db.prepare('SELECT p.cwd FROM projects p JOIN runs r ON r.project_id = p.id WHERE r.id = ?').get(task.run_id) as { cwd: string } | undefined)?.cwd
    : undefined)

  if (!task?.branch || !task.worktree_path || !repoPath) {
    const missing = !task ? 'task' : !task.branch ? 'branch' : !task.worktree_path ? 'worktree_path' : 'repo_path'
    return { ok: true, merged: false, reason: `no_${missing}` }
  }

  const runId = task.run_id ?? undefined
  const integBranch = runId ? RUN_INTEGRATION_BRANCH(runId) : 'mc/integration'

  try {
    await ensureIntegrationBranch(repoPath, runId)
    await mergeWorktreeBranch(repoPath, task.branch, runId, task.worktree_path)
    updateTask(db, taskId, { merged_into_run: true })
    db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
      taskId, 'info', `Merged ${task.branch} into ${integBranch}`
    )
    return { ok: true, merged: true }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)

    // Verify the merge didn't actually land despite the error (e.g. push error after merge commit).
    let landed = false
    try {
      landed = await isMergedInto(repoPath, task.branch, integBranch)
    } catch { /* conservative: assume not landed */ }

    if (landed) {
      updateTask(db, taskId, { merged_into_run: true })
      db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
        taskId, 'warn', `post_merge_cleanup_failed: ${msg}`
      )
      return { ok: true, merged: true }
    } else if (err instanceof MergeConflictError) {
      // KEEP the worktree so the orchestrator and conflict worker can inspect it.
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
      return { ok: false, merged: false, reason: `merge_conflict: ${err.conflictedFiles.join(', ')}` }
    } else {
      db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
        taskId, 'error', `Merge failed: ${task.branch} could not be merged — ${msg}`
      )
      return { ok: false, merged: false, reason: `merge_failed: ${msg}` }
    }
  }
}

export async function handleSpawnWorker(
  db: Database.Database,
  taskId: string,
  agentId: string,
  opts: { pid?: number; cwd?: string } = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  // DAG guard: all upstream blockers must be 'done'
  const blockers = getBlockers(db, taskId)
  const notDone = blockers.filter(blockerId => {
    const t = getTask(db, blockerId)
    return !t || t.status !== 'done'
  })
  if (notDone.length > 0) {
    return {
      ok: false,
      error: `Cannot spawn task ${taskId}: blocked by [${notDone.join(', ')}] which are not done`,
    }
  }

  // Budget guard: if the run has a budget, check cumulative cost
  const task = getTask(db, taskId)
  if (task?.run_id) {
    const run = getRun(db, task.run_id)
    if (run?.budget_usd != null) {
      const runStats = listRunsWithStats(db).find(r => r.id === task.run_id)
      if (runStats && runStats.total_cost_usd >= run.budget_usd) {
        return {
          ok: false,
          error: `Cannot spawn task ${taskId}: run budget of $${run.budget_usd.toFixed(4)} exceeded (current spend: $${runStats.total_cost_usd.toFixed(4)})`,
        }
      }
    }
  }

  let agentCwd = opts.cwd
  let repoPath: string | undefined
  if (opts.cwd) {
    const isMain = await isMainCheckout(opts.cwd)
    if (isMain) {
      repoPath = opts.cwd
      upsertProject(db, { name: path.basename(opts.cwd), cwd: opts.cwd })
      // Save repo_path before worktree creation so retry loop can find it even if creation fails.
      updateTask(db, taskId, { repo_path: opts.cwd })
    } else {
      // opts.cwd is a linked worktree (or non-repo dir) — do NOT overwrite an existing repo_path.
      if (task?.repo_path) {
        repoPath = task.repo_path
      } else {
        const detail = `cwd '${opts.cwd}' is not a main git checkout and task has no existing repo_path`
        updateTask(db, taskId, { status: 'failed', failure_reason: 'repo_path_invalid', failure_detail: detail })
        return { ok: false, error: `Failed to spawn task ${taskId}: ${detail}` }
      }
    }
    try {
      let baseBranch: string | undefined
      if (task?.run_id) {
        const runBranch = `mc/run-${task.run_id}`
        const git = simpleGit(repoPath)
        const branches = await git.branchLocal()
        if (branches.all.includes(runBranch)) {
          baseBranch = runBranch
        }
      }
      const info = await createWorktree(repoPath, taskId, undefined, baseBranch)
      updateTask(db, taskId, { worktree_path: info.path, branch: info.branch, head_sha: info.headSha, repo_path: repoPath })
      agentCwd = info.path
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const failureReason = classifyWorktreeError(msg)
      updateTask(db, taskId, { status: 'failed', failure_reason: failureReason, failure_detail: msg })
      return { ok: false, error: `Failed to create worktree for task ${taskId}: ${msg}` }
    }
  }
  registerAgent(db, { id: agentId, task_id: taskId, pid: opts.pid, cwd: agentCwd, repo_path: repoPath })
  updateTask(db, taskId, { status: 'in_progress', agent_id: agentId, started_at: new Date().toISOString() })
  return { ok: true }
}

export function handleCreateRun(
  db: Database.Database,
  title: string,
  cwd: string,
  external_ref?: string,
  budget_usd?: number,
): { run_id: string } {
  const name = path.basename(cwd) || cwd
  const project = upsertProject(db, { name, cwd })
  const run = createRun(db, { project_id: project.id, title, external_ref, budget_usd })
  return { run_id: run.id }
}

export function handleListProjects(db: Database.Database) {
  return listProjects(db)
}

export function handleListRuns(db: Database.Database, project_id?: string): RunWithStats[] {
  return listRunsWithStats(db, project_id)
}

/**
 * Maps a worktree creation error message to a stable machine-readable slug.
 * Exported so tests can verify classification without calling handleSpawnWorker.
 */
export function classifyWorktreeError(msg: string): string {
  if (/already exists/i.test(msg) && /branch/i.test(msg)) return 'worktree_branch_exists'
  if (/already registered|checked out at/i.test(msg)) return 'worktree_path_registered'
  return 'worktree_create_failed'
}

export interface RecoverAction {
  action: string
  success: boolean
  detail: string
}

export type RecoverVerdict = 'recovered' | 'unrecoverable' | 'needs_human'

export interface RecoverResult {
  task_id: string
  verdict: RecoverVerdict
  reason?: string
  actions: RecoverAction[]
}

export async function handleRecoverTask(
  db: Database.Database,
  taskId: string,
): Promise<RecoverResult> {
  const task = getTask(db, taskId)
  if (!task) {
    return { task_id: taskId, verdict: 'unrecoverable', reason: 'Task not found', actions: [] }
  }

  if (task.status === 'done' || task.status === 'cancelled') {
    return {
      task_id: taskId,
      verdict: 'unrecoverable',
      reason: `Task is already ${task.status}`,
      actions: [],
    }
  }

  if (task.status === 'in_progress') {
    return {
      task_id: taskId,
      verdict: 'needs_human',
      reason: 'Task is in_progress — cancel it first if recovery is needed',
      actions: [],
    }
  }

  if (task.status === 'pending' && !task.failure_reason && !task.agent_id) {
    return {
      task_id: taskId,
      verdict: 'recovered',
      reason: 'Task is already in a spawnable state',
      actions: [],
    }
  }

  const actions: RecoverAction[] = []
  const failureReason = task.failure_reason

  // --- Phase 1: Targeted environment repairs based on failure_reason ---

  if (failureReason?.startsWith('worktree_')) {
    if (task.repo_path) {
      const branch = task.branch ?? `mc/${taskId}`

      if (isProtectedBranch(branch)) {
        return {
          task_id: taskId,
          verdict: 'needs_human',
          reason: `Branch ${branch} is protected — cannot reconcile without risking data loss`,
          actions,
        }
      }

      try {
        const git = simpleGit(task.repo_path)

        let baseBranch: string | undefined
        if (task.run_id) {
          const runBranch = `mc/run-${task.run_id}`
          const branches = await git.branchLocal()
          if (branches.all.includes(runBranch)) {
            baseBranch = runBranch
          }
        }

        const reconcile = await preflightReconcile(git, branch, baseBranch)
        for (const ra of reconcile.actions) {
          actions.push({ action: `git_reconcile:${ra.type}`, success: true, detail: ra.detail })
        }
        if (reconcile.actions.length === 0) {
          actions.push({ action: 'git_reconcile:noop', success: true, detail: `No git state to clean up for branch ${branch}` })
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('Refusing to reconcile')) {
          return { task_id: taskId, verdict: 'needs_human', reason: msg, actions }
        }
        actions.push({ action: 'git_reconcile', success: false, detail: `Git reconciliation failed: ${msg}` })
        return {
          task_id: taskId,
          verdict: 'unrecoverable',
          reason: 'Git reconciliation failed — manual cleanup required',
          actions,
        }
      }
    } else {
      actions.push({ action: 'git_reconcile:skip', success: true, detail: 'No repo_path on task — skipping git reconciliation' })
    }
  }

  if (failureReason === 'tmux_window_create_failed') {
    try {
      const sessionName = ensureTmuxSession()
      reapStaleWindows(sessionName, taskId)
      actions.push({ action: 'tmux_reap_stale_windows', success: true, detail: `Reaped stale tmux windows for task ${taskId}` })
    } catch {
      actions.push({ action: 'tmux_reap_stale_windows', success: false, detail: 'Tmux unavailable — window reaping skipped (next spawn will retry)' })
    }
  }

  if (failureReason === 'tmux_session_create_failed') {
    actions.push({ action: 'diagnose', success: true, detail: 'Tmux session creation failed — ensure tmux is installed and accessible' })
  }

  if (failureReason === 'settings_write_failed') {
    actions.push({ action: 'diagnose', success: true, detail: 'Settings file write failed — check filesystem permissions on the worktree directory' })
  }

  // --- Phase 2: Clear stale agent record ---

  if (task.agent_id) {
    const agent = getAgent(db, task.agent_id)
    if (agent) {
      if (agent.tmux_pane) {
        killTmuxWindow(agent.tmux_pane)
        actions.push({ action: 'kill_agent_tmux_window', success: true, detail: `Killed tmux window ${agent.tmux_pane} for agent ${task.agent_id}` })
      }
      if (agent.status !== 'done' && agent.status !== 'failed') {
        updateAgent(db, task.agent_id, { status: 'failed' })
        actions.push({ action: 'mark_agent_failed', success: true, detail: `Marked agent ${task.agent_id} as failed` })
      }
    }
  }

  // --- Phase 3: Reset task to spawnable state ---

  db.prepare(`
    UPDATE tasks SET
      status = 'pending',
      agent_id = NULL,
      failure_reason = NULL,
      failure_detail = NULL,
      worktree_path = NULL,
      branch = NULL,
      head_sha = NULL,
      started_at = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(taskId)
  actions.push({ action: 'reset_task', success: true, detail: `Reset task ${taskId} to pending state` })

  // --- Phase 4: Verdict ---

  if (failureReason === 'tmux_session_create_failed' || failureReason === 'settings_write_failed') {
    const envMsg = failureReason === 'tmux_session_create_failed'
      ? 'Task reset to pending, but tmux session creation previously failed — ensure tmux is available before re-spawning'
      : 'Task reset to pending, but settings file write previously failed — check filesystem permissions before re-spawning'
    return { task_id: taskId, verdict: 'needs_human', reason: envMsg, actions }
  }

  return { task_id: taskId, verdict: 'recovered', actions }
}

// ---------------------------------------------------------------------------
// Git-oriented orchestrator handlers
// ---------------------------------------------------------------------------

function getRunRepoPath(db: Database.Database, run: { project_id: string }): string | null {
  const proj = db.prepare('SELECT cwd FROM projects WHERE id = ?').get(run.project_id) as { cwd: string } | undefined
  return proj?.cwd ?? null
}

export interface TaskGitInfo {
  id: string
  status: string
  branch: string | null
  merged_into_run: boolean | null
  conflicted_files: string[] | null
}

export interface RunGitStatus {
  runId: string
  integrationBranch: string
  branchExists: boolean
  existsOnRemote: boolean
  ahead: number
  behind: number
  hasRemote: boolean
  github: { owner: string; repo: string } | null
  tasks: TaskGitInfo[]
  blockers: string[]
}

export async function handleGitStatus(
  db: Database.Database,
  runId: string,
): Promise<RunGitStatus | { error: string }> {
  const run = getRun(db, runId)
  if (!run) return { error: `Run '${runId}' not found` }

  const repoPath = getRunRepoPath(db, run)
  if (!repoPath) return { error: `No project directory found for run '${runId}'` }

  const integrationBranch = RUN_INTEGRATION_BRANCH(runId)

  const [syncState, remoteConfigured, remoteUrl] = await Promise.all([
    getBranchSyncState(repoPath, integrationBranch),
    hasRemote(repoPath),
    getRemoteUrl(repoPath),
  ])

  const github = remoteUrl ? parseGitHubRemote(remoteUrl) : null

  const tasks = listTasks(db)
    .filter(t => t.run_id === runId)
    .map(t => ({
      id: t.id,
      status: t.status,
      branch: t.branch,
      merged_into_run: t.merged_into_run,
      conflicted_files: t.conflicted_files,
    }))

  const blockers: string[] = []
  const notDone = tasks.filter(t => t.status !== 'done')
  if (notDone.length > 0) {
    blockers.push(`${notDone.length} task(s) not done: ${notDone.map(t => t.id).join(', ')}`)
  }
  const unmerged = tasks.filter(t => t.status === 'done' && !t.merged_into_run)
  if (unmerged.length > 0) {
    blockers.push(`${unmerged.length} done task(s) not merged into run: ${unmerged.map(t => t.id).join(', ')}`)
  }
  const conflicted = tasks.filter(t => t.conflicted_files && t.conflicted_files.length > 0)
  if (conflicted.length > 0) {
    blockers.push(`${conflicted.length} task(s) have merge conflicts: ${conflicted.map(t => t.id).join(', ')}`)
  }
  if (!syncState.exists) {
    blockers.push(`Integration branch '${integrationBranch}' does not exist locally`)
  }
  if (!remoteConfigured) {
    blockers.push('No origin remote configured')
  }

  return {
    runId,
    integrationBranch,
    branchExists: syncState.exists,
    existsOnRemote: syncState.existsOnRemote,
    ahead: syncState.ahead,
    behind: syncState.behind,
    hasRemote: remoteConfigured,
    github,
    tasks,
    blockers,
  }
}

export async function handlePushRunBranch(
  db: Database.Database,
  runId: string,
): Promise<PushResult> {
  const run = getRun(db, runId)
  if (!run) return { ok: false, reason: 'push_failed', detail: `Run '${runId}' not found` }

  const repoPath = getRunRepoPath(db, run)
  if (!repoPath) return { ok: false, reason: 'push_failed', detail: `No project directory found for run '${runId}'` }

  const branch = RUN_INTEGRATION_BRANCH(runId)
  const result = await pushBranch(repoPath, branch)

  if (!result.ok && result.reason === 'non_fast_forward') {
    const g = simpleGit(repoPath)
    try {
      await g.fetch('origin')
      await g.raw(['merge', `origin/${branch}`, '-m', `merge: origin/${branch} into ${branch} (push retry)`])
    } catch {
      return { ok: false, reason: 'non_fast_forward', detail: `Fetch+merge of origin/${branch} failed; manual reconciliation needed` }
    }
    return pushBranch(repoPath, branch)
  }

  return result
}

export interface CreatePrOpts {
  title?: string
  base?: string
  body?: string
}

export async function handleCreatePr(
  db: Database.Database,
  runId: string,
  opts?: CreatePrOpts,
): Promise<(PrResult & { pushed?: PushResult }) | { ok: false; reason: string; detail: string; pushed?: PushResult }> {
  const run = getRun(db, runId)
  if (!run) return { ok: false, reason: 'run_not_found', detail: `Run '${runId}' not found` }

  if (run.pr_url) {
    return { ok: true, url: run.pr_url, number: 0, alreadyExisted: true }
  }

  const repoPath = getRunRepoPath(db, run)
  if (!repoPath) return { ok: false, reason: 'no_repo', detail: `No project directory found for run '${runId}'` }

  const tasks = listTasks(db).filter(t => t.run_id === runId)

  const notDone = tasks.filter(t => t.status !== 'done')
  if (notDone.length > 0) {
    return { ok: false, reason: 'tasks_not_done', detail: `Cannot create PR: ${notDone.length} task(s) not done: ${notDone.map(t => t.id).join(', ')}` }
  }

  const unmerged = tasks.filter(t => !t.merged_into_run)
  if (unmerged.length > 0) {
    return { ok: false, reason: 'tasks_not_merged', detail: `Cannot create PR: ${unmerged.length} task(s) not merged into run: ${unmerged.map(t => t.id).join(', ')}` }
  }

  const head = RUN_INTEGRATION_BRANCH(runId)

  const pushed = await handlePushRunBranch(db, runId)
  if (!pushed.ok) {
    return { ok: false, reason: 'push_failed', detail: `Cannot create PR: push failed — ${pushed.detail}`, pushed }
  }

  const base = opts?.base ?? await resolveDefaultBranch(repoPath)
  const title = opts?.title ?? run.title

  let body: string
  if (opts?.body) {
    body = opts.body
  } else {
    const lines = ['## Tasks included']
    for (const t of tasks) {
      const summary = getLastDoneSummary(db, t.id)
      lines.push(`- **${t.id}**: ${summary ?? t.title}`)
    }
    const tickets = [...new Set(tasks.map(t => t.ticket).filter((t): t is string => t != null))]
    if (tickets.length > 0) {
      lines.push('')
      lines.push(tickets.map(t => `closes ${t}`).join(', '))
    }
    body = lines.join('\n')
  }

  const prResult = await createPullRequest({ repoPath, head, base, title, body })

  if (prResult.ok) {
    updateRun(db, runId, { pr_url: prResult.url })
  }

  return { ...prResult, pushed }
}

function getLastDoneSummary(db: Database.Database, taskId: string): string | null {
  const row = db.prepare(
    "SELECT message FROM logs WHERE task_id = ? AND level = 'info' AND message LIKE 'DONE:%' ORDER BY created_at DESC LIMIT 1"
  ).get(taskId) as { message: string } | undefined
  if (!row) return null
  return row.message.replace(/^DONE:\s*/, '')
}

async function resolveDefaultBranch(repoPath: string): Promise<string> {
  const g = simpleGit(repoPath)
  try {
    const ref = (await g.raw(['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim()
    return ref.replace(/^refs\/remotes\/origin\//, '')
  } catch {
    return 'main'
  }
}

export interface ResolveResult {
  ok: boolean
  needsWorker?: boolean
  conflictedFiles?: string[]
  detail?: string
  workerSpawned?: boolean
  conflictTaskId?: string
}

export async function handleResolveMergeConflict(
  db: Database.Database,
  taskId: string,
  opts?: { strategy?: 'ours' | 'theirs' },
): Promise<ResolveResult> {
  const task = getTask(db, taskId)
  if (!task) return { ok: false, detail: `Task '${taskId}' not found` }

  const isConflictState = task.failure_reason === 'merge_conflict'
  const isDoneUnmerged = task.status === 'done' && !task.merged_into_run

  if (!isConflictState && !isDoneUnmerged) {
    return {
      ok: false,
      detail: `Task '${taskId}' is not in merge_conflict state and is not a done-but-unmerged task (failure_reason: ${task.failure_reason ?? 'none'}, status: ${task.status}, merged_into_run: ${task.merged_into_run ?? null})`,
    }
  }

  if (!task.branch || !task.repo_path) {
    return { ok: false, detail: `Task '${taskId}' missing branch or repo_path` }
  }

  const repoPath = task.repo_path

  try {
    await ensureIntegrationBranch(repoPath, task.run_id ?? undefined)
    await mergeWorktreeBranch(repoPath, task.branch, task.run_id ?? undefined, task.worktree_path ?? undefined)

    updateTask(db, taskId, {
      status: 'done',
      merged_into_run: true,
      conflicted_files: null,
      conflict_branch: null,
      failure_reason: undefined,
      failure_detail: undefined,
    })

    return { ok: true }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)

    const conflictMatch = msg.match(/conflicted files: (.+)/)
    let conflictedFiles = task.conflicted_files ?? []
    if (conflictMatch) {
      conflictedFiles = conflictMatch[1].split(', ').filter(Boolean)
    }

    const autoResolvable = conflictedFiles.filter(f => isAutoResolvable(f))
    const nonAutoResolvable = conflictedFiles.filter(f => !isAutoResolvable(f))

    if (nonAutoResolvable.length === 0) {
      return { ok: false, detail: `Auto-resolvable files still conflicting unexpectedly: ${autoResolvable.join(', ')}` }
    }

    if (opts?.strategy) {
      const g = simpleGit(repoPath)
      const integBranch = task.conflict_branch ?? RUN_INTEGRATION_BRANCH(task.run_id ?? '')
      try {
        await g.raw(['checkout', integBranch])
        try {
          await g.merge([task.branch, '--no-ff', '-m', `merge: ${task.branch} into ${integBranch} (conflict resolution)`])
        } catch {
          const currentConflicted = (await g.raw(['diff', '--name-only', '--diff-filter=U'])).trim().split('\n').filter(Boolean)
          if (currentConflicted.length > 0) {
            await g.raw(['checkout', `--${opts.strategy}`, ...currentConflicted])
            await g.raw(['add', ...currentConflicted])
            await g.raw(['commit', '-m', `merge: ${task.branch} into ${integBranch} (conflict resolved with ${opts.strategy})`])
          }
        }

        updateTask(db, taskId, {
          status: 'done',
          merged_into_run: true,
          conflicted_files: null,
          conflict_branch: null,
          failure_reason: undefined,
          failure_detail: undefined,
        })

        return { ok: true }
      } catch (strategyErr: unknown) {
        const strategyMsg = strategyErr instanceof Error ? strategyErr.message : String(strategyErr)
        try { await g.raw(['merge', '--abort']) } catch { /* ignore */ }
        // For done+unmerged tasks, set merge_conflict state so spawnConflictResolutionWorker accepts the task.
        if (isDoneUnmerged) {
          updateTask(db, taskId, {
            status: 'failed',
            failure_reason: 'merge_conflict',
            failure_detail: strategyMsg,
            conflicted_files: nonAutoResolvable,
            conflict_branch: integBranch,
          })
        }
        const spawnResult = await spawnConflictResolutionWorker(db, taskId)
        return {
          ok: false,
          needsWorker: true,
          conflictedFiles: nonAutoResolvable,
          workerSpawned: spawnResult.ok,
          conflictTaskId: spawnResult.ok ? spawnResult.conflictTaskId : undefined,
          detail: `Strategy resolution failed: ${strategyMsg}${spawnResult.ok ? '' : `; worker spawn failed: ${spawnResult.detail}`}`,
        }
      }
    }

    // For done+unmerged tasks, set merge_conflict state so spawnConflictResolutionWorker accepts the task.
    if (isDoneUnmerged) {
      updateTask(db, taskId, {
        status: 'failed',
        failure_reason: 'merge_conflict',
        failure_detail: msg,
        conflicted_files: nonAutoResolvable,
        conflict_branch: task.run_id ? RUN_INTEGRATION_BRANCH(task.run_id) : 'mc/integration',
      })
    }
    const spawnResult = await spawnConflictResolutionWorker(db, taskId)
    return {
      ok: false,
      needsWorker: true,
      conflictedFiles: nonAutoResolvable,
      workerSpawned: spawnResult.ok,
      conflictTaskId: spawnResult.ok ? spawnResult.conflictTaskId : undefined,
      detail: spawnResult.ok ? undefined : `Worker spawn failed: ${spawnResult.detail}`,
    }
  }
}

function buildConflictWorkerDescription(task: Task, integBranch: string): string {
  const files = task.conflicted_files ?? []
  return [
    `Resolve merge conflict between ${task.branch} and ${integBranch}.`,
    '',
    'Conflicted files:',
    ...files.map(f => `- ${f}`),
    '',
    'The merge has already been started in your working directory.',
    'You will see conflict markers (<<<<<<, =======, >>>>>>>) in the files above.',
    '',
    'For each conflicted file:',
    '1. Understand what the task branch intended to change (the HEAD / top section)',
    '2. Understand what the integration branch changed (the bottom section)',
    '3. Preserve the intent of BOTH changes when possible',
    '4. NEVER use --ours or --theirs on source files',
    '5. Stage each resolved file with: git add <file>',
    '',
    'After resolving ALL conflicts:',
    '1. Run the test suite to verify correctness',
    '2. Commit the merge: git commit --no-edit',
    '3. Call report_done with a summary of what you reconciled and how',
    '',
    `Original task: "${task.title}" (ID: ${task.id})`,
    `Task branch: ${task.branch}`,
    `Integration branch: ${integBranch}`,
  ].join('\n')
}

export async function spawnConflictResolutionWorker(
  db: Database.Database,
  originalTaskId: string,
): Promise<{ ok: true; conflictTaskId: string } | { ok: false; detail: string }> {
  const task = getTask(db, originalTaskId)
  if (!task) return { ok: false, detail: `Task '${originalTaskId}' not found` }
  if (task.failure_reason !== 'merge_conflict') {
    return { ok: false, detail: `Task '${originalTaskId}' is not in merge_conflict state (failure_reason: ${task.failure_reason ?? 'none'})` }
  }
  if (!task.branch || !task.repo_path) {
    return { ok: false, detail: `Task '${originalTaskId}' missing branch or repo_path` }
  }
  if (!task.conflicted_files?.length) {
    return { ok: false, detail: `Task '${originalTaskId}' has no conflicted_files recorded` }
  }

  const integBranch = task.run_id
    ? RUN_INTEGRATION_BRANCH(task.run_id)
    : (task.conflict_branch ?? 'mc/integration')

  const conflictTaskId = `conflict-${originalTaskId}`

  // Idempotency: if a live conflict worker already exists, return it
  const existing = getTask(db, conflictTaskId)
  if (existing) {
    if (existing.status === 'in_progress' || existing.status === 'pending') {
      return { ok: true, conflictTaskId }
    }
    if (existing.status === 'done') {
      return { ok: false, detail: `Conflict worker '${conflictTaskId}' already completed` }
    }
    // 'failed' or 'cancelled' — do not re-create automatically; caller must recover explicitly
    return { ok: false, detail: `Conflict worker '${conflictTaskId}' exists with status '${existing.status}' — recover or cancel it first` }
  }

  // 1. Create the conflict worker task
  createTask(db, {
    id: conflictTaskId,
    title: `Resolve merge conflict: ${task.conflicted_files.join(', ')}`,
    description: buildConflictWorkerDescription(task, integBranch),
    model: task.model ?? 'sonnet',
    effort: 'max',
    run_id: task.run_id ?? undefined,
    conflict_worker_for: originalTaskId,
  })

  // 2. Create a worktree based on the integration branch
  let worktreeInfo: Awaited<ReturnType<typeof createWorktree>>
  try {
    worktreeInfo = await createWorktree(task.repo_path, conflictTaskId, undefined, integBranch)
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    updateTask(db, conflictTaskId, { status: 'failed', failure_reason: 'worktree_create_failed', failure_detail: detail })
    return { ok: false, detail: `Failed to create conflict worker worktree: ${detail}` }
  }

  // 3. Set up the merge-in-progress state in the worktree.
  // Run git merge to reproduce the conflict. simple-git throws on conflict;
  // we catch and confirm conflicted files are present (expected state).
  const wtGit = simpleGit(worktreeInfo.path)
  try {
    await wtGit.merge([task.branch, '--no-ff', '-m', `merge: ${task.branch} into ${integBranch} (conflict resolution)`])
    // Merge succeeded without conflicts — no longer conflicting.
    // The merge is committed; the worker just needs to report_done.
  } catch {
    // Expected: conflicts remain in the worktree for the worker to resolve.
    // Verify the merge state was actually set up (in case of unexpected error).
    const conflictedNow = (await wtGit.raw(['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim()
    if (!conflictedNow) {
      // No conflicts and merge failed — something unexpected happened
      await removeWorktree(task.repo_path, { path: worktreeInfo.path, branch: worktreeInfo.branch }).catch(() => {})
      updateTask(db, conflictTaskId, {
        status: 'failed',
        failure_reason: 'conflict_setup_failed',
        failure_detail: 'git merge failed but no conflicted files found — unexpected state',
      })
      return { ok: false, detail: 'Failed to reproduce merge conflict state in worktree' }
    }
  }

  // 4. Record worktree info on the conflict task
  updateTask(db, conflictTaskId, {
    worktree_path: worktreeInfo.path,
    branch: worktreeInfo.branch,
    head_sha: worktreeInfo.headSha,
    repo_path: task.repo_path,
  })

  // 5. Register agent in 'spawning' status — the spawner watcher in cli.ts
  //    picks this up and launches the subprocess through the normal backend seam.
  const agentId = `w-${conflictTaskId}`
  registerAgent(db, { id: agentId, task_id: conflictTaskId, cwd: worktreeInfo.path })
  updateTask(db, conflictTaskId, {
    status: 'in_progress',
    agent_id: agentId,
    started_at: new Date().toISOString(),
  })

  // 6. Note on original task that a resolution worker has been spawned
  updateTask(db, originalTaskId, {
    failure_detail: `${task.failure_detail ? task.failure_detail + '\n' : ''}Conflict resolution worker spawned: ${conflictTaskId}`,
  })
  db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
    originalTaskId, 'info', `Conflict resolution worker spawned: ${conflictTaskId} (branch: ${worktreeInfo.branch})`
  )

  return { ok: true, conflictTaskId }
}
