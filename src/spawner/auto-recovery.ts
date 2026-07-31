import type Database from 'better-sqlite3'
import type { Task } from '../server/state/tasks.js'
import type { RecoverResult } from '../server/tools/orchestrator.js'
import { updateTask } from '../server/state/tasks.js'

/** Hard cap on auto-recovery attempts per task across its entire lifetime. */
export const MAX_RECOVERY_ATTEMPTS = 2

/**
 * Returns true when auto-recovery should be attempted before consuming a retry slot.
 * Conditions: task has a failure_reason (environment issue) AND is under the recovery cap.
 */
export function shouldAttemptRecovery(task: Task): boolean {
  return !!task.failure_reason && task.recovery_attempts < MAX_RECOVERY_ATTEMPTS
}

/**
 * Apply the outcome of a recovery attempt to the DB.
 *
 * On 'recovered':
 *   - Increments recovery_attempts.
 *   - Returns 'respawn' so the caller can call handleSpawnWorker without consuming a retry.
 *
 * On 'unrecoverable' or 'needs_human':
 *   - Sets retry_count = max_retries to permanently exclude from the retry loop.
 *   - Writes failure_reason and failure_detail so the orchestrator can escalate with context.
 *   - Returns 'escalate'.
 */
export function applyRecoveryOutcome(
  db: Database.Database,
  task: Task,
  result: RecoverResult,
): 'respawn' | 'escalate' {
  const newCount = task.recovery_attempts + 1

  db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
    task.id,
    result.verdict === 'recovered' ? 'info' : 'error',
    `Auto-recovery attempt ${newCount}: ${result.verdict}${result.reason ? ' — ' + result.reason : ''}`,
  )

  if (result.verdict === 'recovered') {
    updateTask(db, task.id, { recovery_attempts: newCount })
    return 'respawn'
  }

  // unrecoverable or needs_human — exhaust retries so the task stays out of the retry loop
  updateTask(db, task.id, {
    status: 'failed',
    retry_count: task.max_retries,
    failure_reason: result.verdict,
    failure_detail: result.reason ?? 'Auto-recovery failed',
    recovery_attempts: newCount,
  })
  return 'escalate'
}
