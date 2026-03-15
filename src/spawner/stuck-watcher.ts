import type Database from 'better-sqlite3'
import { getTask, updateTask } from '../server/state/tasks.js'
import { updateAgent } from '../server/state/agents.js'

interface RunningAgentRow {
  id: string
  task_id: string | null
  status: string
}

/**
 * Check all running agents for stuck workers and take action:
 * - Warn (insert a log entry) if no log activity for >= stuckWarningMinutes
 * - Fail (mark task failed) if no log activity for >= stuckTimeoutMinutes
 *
 * `stuckSince` is an in-memory Map<taskId, timestamp> tracking the first time
 * we noticed a worker was stuck — callers must pass the same Map across calls.
 */
export function checkStuckWorkers(
  db: Database.Database,
  stuckSince: Map<string, number>,
  stuckWarningMinutes: number,
  stuckTimeoutMinutes: number,
  now: number = Date.now(),
): void {
  const runningAgents = db.prepare(
    "SELECT id, task_id, status FROM agents WHERE status = 'running'"
  ).all() as RunningAgentRow[]

  for (const agent of runningAgents) {
    if (!agent.task_id) continue
    const task = getTask(db, agent.task_id)
    if (!task || task.status !== 'in_progress') continue

    // Most recent log entry for this task
    const logRow = db.prepare(
      'SELECT MAX(created_at) AS last_log FROM logs WHERE task_id = ?'
    ).get(agent.task_id) as { last_log: string | null }

    // Fall back to task start time when no logs exist yet
    const referenceIso = logRow.last_log ?? task.started_at
    const referenceMs = referenceIso ? new Date(referenceIso).getTime() : now
    const idleMs = now - referenceMs
    const idleMinutes = idleMs / 60_000

    if (idleMinutes >= stuckTimeoutMinutes) {
      console.warn(
        `[stuck-watcher] Task ${task.id} timed out after ${stuckTimeoutMinutes}m with no log activity`
      )
      updateTask(db, task.id, { status: 'failed' })
      updateAgent(db, agent.id, { status: 'failed' })
      db.prepare(
        'INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)'
      ).run(task.id, 'error', `timed out after ${stuckTimeoutMinutes}m with no log activity`)
      stuckSince.delete(task.id)
    } else if (idleMinutes >= stuckWarningMinutes) {
      if (!stuckSince.has(task.id)) {
        stuckSince.set(task.id, now)
        console.warn(
          `[stuck-watcher] Task ${task.id} has had no log activity for ${Math.round(idleMinutes)}m`
        )
        db.prepare(
          'INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)'
        ).run(task.id, 'warn', `no log activity for ${Math.round(idleMinutes)}m (stuck warning)`)
      }
    } else {
      // Activity resumed — clear any stuck tracking
      stuckSince.delete(task.id)
    }
  }
}
