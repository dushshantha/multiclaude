import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { checkStuckWorkers, isPaneBusy } from '../../src/spawner/stuck-watcher.js'
import type Database from 'better-sqlite3'

const WARNING_MINUTES = 5
const TIMEOUT_MINUTES = 10

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

describe('isPaneBusy', () => {
  it('returns true when "esc to interrupt" appears in last 6 non-blank lines', () => {
    const text = 'some output\nmore output\nesc to interrupt'
    expect(isPaneBusy(text)).toBe(true)
  })

  it('returns true for "Working..." in last 6 lines', () => {
    const text = 'line1\nline2\nWorking...'
    expect(isPaneBusy(text)).toBe(true)
  })

  it('is case-insensitive for busy patterns', () => {
    expect(isPaneBusy('ESC TO INTERRUPT')).toBe(true)
    expect(isPaneBusy('WORKING...')).toBe(true)
  })

  it('returns false when no busy pattern present', () => {
    expect(isPaneBusy('some idle output\nwaiting for input')).toBe(false)
  })

  it('ignores busy patterns that appear only beyond the last 6 non-blank lines', () => {
    const lines = [
      'esc to interrupt', // this is older, beyond last 6
      'line a',
      'line b',
      'line c',
      'line d',
      'line e',
      'line f',
      'idle now',
    ]
    const text = lines.join('\n')
    expect(isPaneBusy(text)).toBe(false)
  })

  it('strips ANSI escape sequences before matching', () => {
    const text = '\x1b[1mesc to interrupt\x1b[0m'
    expect(isPaneBusy(text)).toBe(true)
  })

  it('handles empty string', () => {
    expect(isPaneBusy('')).toBe(false)
  })
})

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

  // --- tmux pane busy-detection tests ---

  it('skips stuck check when tmux pane shows "esc to interrupt"', () => {
    // Old logs that would normally trigger a timeout
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'old', ?)"
    ).run(minutesAgo(TIMEOUT_MINUTES + 5))
    db.prepare("UPDATE agents SET tmux_pane = 'sess:mc-t1' WHERE id = 'a1'").run()

    const stuckSince = new Map<string, number>()
    const mockCapture = (_target: string, _lines: number) => 'some output\nesc to interrupt'
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES, Date.now(), mockCapture)

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('in_progress') // not failed — pane is busy
    expect(stuckSince.has('t1')).toBe(false)
  })

  it('skips stuck check when tmux pane shows "Working..."', () => {
    db.prepare(
      "UPDATE tasks SET started_at = ? WHERE id = 't1'"
    ).run(minutesAgo(TIMEOUT_MINUTES + 5))
    db.prepare("UPDATE agents SET tmux_pane = 'sess:mc-t1' WHERE id = 'a1'").run()

    const stuckSince = new Map<string, number>()
    const mockCapture = (_target: string, _lines: number) => 'line1\nline2\nWorking...'
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES, Date.now(), mockCapture)

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('in_progress')
  })

  it('uses correct pane target and line count when capturing', () => {
    db.prepare("UPDATE agents SET tmux_pane = 'mysess:mc-task1' WHERE id = 'a1'").run()

    const calls: Array<[string, number]> = []
    const mockCapture = (target: string, lines: number) => {
      calls.push([target, lines])
      return 'idle output'
    }

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES, Date.now(), mockCapture)

    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('mysess:mc-task1')
    expect(calls[0][1]).toBe(6)
  })

  it('falls through to timestamp check when pane is not busy', () => {
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'old', ?)"
    ).run(minutesAgo(TIMEOUT_MINUTES + 1))
    db.prepare("UPDATE agents SET tmux_pane = 'sess:mc-t1' WHERE id = 'a1'").run()

    const stuckSince = new Map<string, number>()
    // Pane is idle — should fall through to timestamp-based check
    const mockCapture = (_target: string, _lines: number) => 'idle pane output'
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES, Date.now(), mockCapture)

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('failed') // timed out as normal
  })

  it('clears stuckSince when busy pane is detected', () => {
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'old', ?)"
    ).run(minutesAgo(WARNING_MINUTES + 1))
    db.prepare("UPDATE agents SET tmux_pane = 'sess:mc-t1' WHERE id = 'a1'").run()

    const stuckSince = new Map<string, number>()
    stuckSince.set('t1', Date.now() - 60_000) // simulate previously detected as stuck

    const mockCapture = (_target: string, _lines: number) => 'Working...'
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES, Date.now(), mockCapture)

    // Busy pane clears stuck tracking
    expect(stuckSince.has('t1')).toBe(false)
  })

  it('does not capture pane when agent has no tmux_pane', () => {
    // No tmux_pane set on agent
    const captureCallCount = { n: 0 }
    const mockCapture = (_target: string, _lines: number) => {
      captureCallCount.n++
      return ''
    }

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, WARNING_MINUTES, TIMEOUT_MINUTES, Date.now(), mockCapture)

    expect(captureCallCount.n).toBe(0) // no capture attempted
  })
})
