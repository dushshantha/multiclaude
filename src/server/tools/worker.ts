import type Database from 'better-sqlite3'
import { getTask, updateTask } from '../state/tasks.js'
import type { Task } from '../state/tasks.js'
import { updateAgent } from '../state/agents.js'
import { ensureIntegrationBranch, mergeWorktreeBranch } from '../../git/merge.js'
import { removeWorktree } from '../../git/worktree.js'

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
  opts: { input_tokens?: number; output_tokens?: number; total_tokens?: number; duration_seconds?: number } = {}
): Promise<void> {
  const task = getTask(db, taskId)
  const duration_seconds = opts.duration_seconds ?? (task?.started_at
    ? (Date.now() - new Date(task.started_at).getTime()) / 1000
    : undefined)

  // Merge worktree branch into mc/integration if a worktree was created
  if (task?.worktree_path && task.branch) {
    const projectRow = task.run_id
      ? (db.prepare('SELECT p.cwd FROM projects p JOIN runs r ON r.project_id = p.id WHERE r.id = ?').get(task.run_id) as { cwd: string } | undefined)
      : undefined
    const projectCwd = projectRow?.cwd
    if (projectCwd) {
      try {
        await ensureIntegrationBranch(projectCwd)
        await mergeWorktreeBranch(projectCwd, task.branch)
        db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
          taskId, 'info', `Merged ${task.branch} into mc/integration`
        )
        await removeWorktree(projectCwd, { path: task.worktree_path, branch: task.branch, taskId })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
          taskId, 'error', `Merge conflict: ${task.branch} could not be merged into mc/integration — ${msg}`
        )
        updateTask(db, taskId, { status: 'failed' })
        if (task.agent_id) updateAgent(db, task.agent_id, { status: 'done' })
        return
      }
    }
  }

  updateTask(db, taskId, {
    status: 'done',
    duration_seconds,
    input_tokens: opts.input_tokens,
    output_tokens: opts.output_tokens,
    total_tokens: opts.total_tokens,
  })
  db.prepare(
    'INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)'
  ).run(taskId, 'info', `DONE: ${summary}`)
  // Mark the agent done so the spawner watcher's exit handler doesn't flag it as failed
  if (task?.agent_id) {
    updateAgent(db, task.agent_id, { status: 'done' })
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
