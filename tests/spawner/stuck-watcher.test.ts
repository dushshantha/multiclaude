import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { checkStuckWorkers } from '../../src/spawner/stuck-watcher.js'
import type Database from 'better-sqlite3'

const WARNING_MINUTES = 5
const TIMEOUT_MINUTES = 10

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

describe('checkStuckWorkers', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    // Insert a task + running agent for tests
    db.prepare(
      "INSERT INTO tasks (id, title, status, started_at) VALUES ('t1', 'Test Task', 'in_progress', ?)"
    ).run(minutesAgo(0))
    db.prepare(
      "INSERT INTO agents (id, task_id, status) VALUES ('a1', 't1', 'running')"
    ).run()
  })

  afterEach(() => {
    closeDb(db)
  })

  it('does nothing when last log is within warning window', () => {
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'working', ?)"
    ).run(minutesAgo(1)) // 1 minute ago — well within 5m warning

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES)

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('in_progress')
    expect(stuckSince.size).toBe(0)

    const warnLogs = db.prepare(
      "SELECT * FROM logs WHERE task_id = 't1' AND level = 'warn'"
    ).all()
    expect(warnLogs).toHaveLength(0)
  })

  it('emits a warning log when no activity for >= stuckWarningMinutes', () => {
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'old update', ?)"
    ).run(minutesAgo(WARNING_MINUTES + 1)) // past the warning threshold

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES)

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('in_progress') // not failed yet — just warned

    const warnLogs = db.prepare(
      "SELECT * FROM logs WHERE task_id = 't1' AND level = 'warn'"
    ).all()
    expect(warnLogs).toHaveLength(1)
    expect(stuckSince.has('t1')).toBe(true)
  })

  it('does not duplicate warning logs on subsequent checks', () => {
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'old update', ?)"
    ).run(minutesAgo(WARNING_MINUTES + 1))

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES)
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES) // second call

    const warnLogs = db.prepare(
      "SELECT * FROM logs WHERE task_id = 't1' AND level = 'warn'"
    ).all()
    expect(warnLogs).toHaveLength(1) // still just one warning
  })

  it('marks task as failed when no activity for >= stuckTimeoutMinutes', () => {
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'old update', ?)"
    ).run(minutesAgo(TIMEOUT_MINUTES + 1)) // past timeout threshold

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES)

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('failed')

    const agent = db.prepare("SELECT status FROM agents WHERE id = 'a1'").get() as { status: string }
    expect(agent.status).toBe('failed')

    const errorLogs = db.prepare(
      "SELECT * FROM logs WHERE task_id = 't1' AND level = 'error'"
    ).all() as { message: string }[]
    expect(errorLogs).toHaveLength(1)
    expect(errorLogs[0].message).toContain(`timed out after ${TIMEOUT_MINUTES}m`)

    // Should be removed from stuckSince after timeout
    expect(stuckSince.has('t1')).toBe(false)
  })

  it('uses task started_at when no logs exist', () => {
    // No log entries, but task was started > timeout ago
    db.prepare(
      "UPDATE tasks SET started_at = ? WHERE id = 't1'"
    ).run(minutesAgo(TIMEOUT_MINUTES + 5))

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES)

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('failed')
  })

  it('clears stuck tracking when activity resumes', () => {
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'old', ?)"
    ).run(minutesAgo(WARNING_MINUTES + 1))

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES)
    expect(stuckSince.has('t1')).toBe(true)

    // New log entry within warning window — activity resumed
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'back', ?)"
    ).run(minutesAgo(1))
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES)
    expect(stuckSince.has('t1')).toBe(false)
  })

  it('ignores agents that are not running', () => {
    db.prepare("UPDATE agents SET status = 'done' WHERE id = 'a1'").run()
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'old', ?)"
    ).run(minutesAgo(TIMEOUT_MINUTES + 1))

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES)

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('in_progress') // not failed — agent is done, not running
  })
})
