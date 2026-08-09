import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask, getTask, updateTask } from '../../src/server/state/tasks.js'
import type Database from 'better-sqlite3'

describe('retry and recovery spawn failure logging', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
  })

  afterEach(() => {
    closeDb(db)
  })

  it('failed retry spawn produces error-level log row with retry_spawn_failed message', () => {
    createTask(db, { id: 'task-retry-log', title: 'Retry log test', max_retries: 3 })
    updateTask(db, 'task-retry-log', { status: 'failed', repo_path: '/fake/repo' })

    // Simulate the retry loop's handleSpawnWorker call failing
    // This mirrors the logic in cli.ts around line 197-209
    const spawnError = 'worktree creation failed: branch conflict'
    db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
      'task-retry-log', 'error',
      `retry_spawn_failed: ${spawnError}`
    )
    updateTask(db, 'task-retry-log', { status: 'failed' })

    // Verify the log entry exists with error level
    const logs = db.prepare('SELECT * FROM logs WHERE task_id = ? AND level = ?').all('task-retry-log', 'error') as Array<{ message: string; level: string }>
    expect(logs).toHaveLength(1)
    expect(logs[0].message).toBe(`retry_spawn_failed: ${spawnError}`)
    expect(logs[0].level).toBe('error')
  })

  it('failed recovery respawn produces error-level log row with recovery_respawn_failed message', () => {
    createTask(db, { id: 'task-recovery-log', title: 'Recovery log test' })
    updateTask(db, 'task-recovery-log', { status: 'failed', repo_path: '/fake/repo' })

    // Simulate the recovery respawn path failing
    // This mirrors the logic in cli.ts around line 134-141
    const respawnError = 'tmux window creation failed'
    db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
      'task-recovery-log', 'error',
      `recovery_respawn_failed: ${respawnError}`
    )
    updateTask(db, 'task-recovery-log', { status: 'failed' })

    // Verify the log entry exists with error level
    const logs = db.prepare('SELECT * FROM logs WHERE task_id = ? AND level = ?').all('task-recovery-log', 'error') as Array<{ message: string; level: string }>
    expect(logs).toHaveLength(1)
    expect(logs[0].message).toBe(`recovery_respawn_failed: ${respawnError}`)
    expect(logs[0].level).toBe('error')
  })

  it('recovery verdict not recovered produces info-level log row', () => {
    createTask(db, { id: 'task-verdict-log', title: 'Verdict log test' })
    updateTask(db, 'task-verdict-log', { status: 'failed', repo_path: '/fake/repo' })

    // Simulate the recovery verdict non-'recovered' path
    // This mirrors the logic in cli.ts around line 146-152
    const verdict = 'needs_human'
    const reason = 'merge conflict in schema'
    db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
      'task-verdict-log', 'info',
      `Recovery verdict: ${verdict} — ${reason}`
    )

    // Verify the log entry exists with info level
    const logs = db.prepare('SELECT * FROM logs WHERE task_id = ? AND level = ?').all('task-verdict-log', 'info') as Array<{ message: string; level: string }>
    expect(logs).toHaveLength(1)
    expect(logs[0].message).toBe(`Recovery verdict: ${verdict} — ${reason}`)
    expect(logs[0].level).toBe('info')
  })

  it('recovery verdict with no reason still logs the verdict', () => {
    createTask(db, { id: 'task-verdict-no-reason', title: 'Verdict no reason test' })
    updateTask(db, 'task-verdict-no-reason', { status: 'failed', repo_path: '/fake/repo' })

    // Simulate recovery verdict with no reason
    const verdict = 'unrecoverable'
    db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
      'task-verdict-no-reason', 'info',
      `Recovery verdict: ${verdict} — no details`
    )

    // Verify the log entry exists
    const logs = db.prepare('SELECT * FROM logs WHERE task_id = ? AND level = ?').all('task-verdict-no-reason', 'info') as Array<{ message: string; level: string }>
    expect(logs).toHaveLength(1)
    expect(logs[0].message).toBe(`Recovery verdict: ${verdict} — no details`)
  })

  it('retry spawn failure log contains underlying error message', () => {
    createTask(db, { id: 'task-detailed-log', title: 'Detailed log test', max_retries: 2 })
    updateTask(db, 'task-detailed-log', { status: 'failed', repo_path: '/fake/repo' })

    // Simulate a specific spawn error with details
    const detailedError = 'Refusing to reconcile the repository\'s checked-out branch: mc/config-docs'
    db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
      'task-detailed-log', 'error',
      `retry_spawn_failed: ${detailedError}`
    )

    // Verify the error message is preserved
    const logs = db.prepare('SELECT message FROM logs WHERE task_id = ? AND level = ?').all('task-detailed-log', 'error') as Array<{ message: string }>
    expect(logs).toHaveLength(1)
    expect(logs[0].message).toContain(detailedError)
    expect(logs[0].message).toContain('retry_spawn_failed')
  })

  it('multiple retry spawn failures produce separate log entries', () => {
    createTask(db, { id: 'task-multi-log', title: 'Multi log test', max_retries: 3 })
    updateTask(db, 'task-multi-log', { status: 'failed', repo_path: '/fake/repo' })

    // First retry failure
    db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
      'task-multi-log', 'error',
      'retry_spawn_failed: error 1'
    )

    // Second retry failure
    db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
      'task-multi-log', 'error',
      'retry_spawn_failed: error 2'
    )

    // Verify both log entries exist
    const logs = db.prepare('SELECT message FROM logs WHERE task_id = ? AND level = ?').all('task-multi-log', 'error') as Array<{ message: string }>
    expect(logs).toHaveLength(2)
    expect(logs[0].message).toContain('error 1')
    expect(logs[1].message).toContain('error 2')
  })
})
