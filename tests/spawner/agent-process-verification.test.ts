import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask, getTask, updateTask } from '../../src/server/state/tasks.js'
import { registerAgent, updateAgent, getAgent } from '../../src/server/state/agents.js'
import { checkStuckWorkers, AGENT_NEVER_STARTED_REASON } from '../../src/spawner/stuck-watcher.js'
import type Database from 'better-sqlite3'

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

function secondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString()
}

describe('agent process verification: never-started path', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    // Task in_progress, agent still spawning (never called get_my_task)
    db.prepare(
      "INSERT INTO tasks (id, title, status, started_at) VALUES ('t1', 'Test', 'in_progress', ?)"
    ).run(secondsAgo(70)) // started 70s ago
    db.prepare(
      "INSERT INTO agents (id, task_id, status) VALUES ('a1', 't1', 'spawning')"
    ).run()
  })

  afterEach(() => {
    closeDb(db)
  })

  it('marks task and agent failed when spawning agent has no logs after firstActivitySeconds', () => {
    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, 5, 10, Date.now(), () => '', () => {}, 60)

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    const agent = db.prepare("SELECT status FROM agents WHERE id = 'a1'").get() as { status: string }
    expect(task.status).toBe('failed')
    expect(agent.status).toBe('failed')
  })

  it('writes the canonical AGENT_NEVER_STARTED_REASON to logs', () => {
    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, 5, 10, Date.now(), () => '', () => {}, 60)

    const logs = db.prepare(
      "SELECT message FROM logs WHERE task_id = 't1' AND level = 'error'"
    ).all() as { message: string }[]
    expect(logs).toHaveLength(1)
    expect(logs[0].message).toBe(AGENT_NEVER_STARTED_REASON)
  })

  it('kills the tmux window when agent never started', () => {
    db.prepare("UPDATE agents SET tmux_pane = '@99' WHERE id = 'a1'").run()
    const killed: string[] = []
    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, 5, 10, Date.now(), () => '', (id) => killed.push(id), 60)

    expect(killed).toEqual(['@99'])
  })

  it('does not trigger before firstActivitySeconds elapses', () => {
    // started only 30s ago — not yet past the 60s heartbeat
    db.prepare("UPDATE tasks SET started_at = ? WHERE id = 't1'").run(secondsAgo(30))

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, 5, 10, Date.now(), () => '', () => {}, 60)

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('in_progress') // too early to fail
  })

  it('does not trigger when spawning agent already has log entries', () => {
    // Even if agent is spawning, if it wrote a log it's doing something
    db.prepare(
      "INSERT INTO logs (task_id, level, message) VALUES ('t1', 'info', 'progress update')"
    ).run()

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, 5, 10, Date.now(), () => '', () => {}, 60)

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('in_progress') // has logs — not treated as never-started
  })

  it('does not re-trigger when task is already failed', () => {
    db.prepare("UPDATE tasks SET status = 'failed' WHERE id = 't1'").run()

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, 5, 10, Date.now(), () => '', () => {}, 60)

    // Should not write any extra logs
    const logs = db.prepare("SELECT * FROM logs WHERE task_id = 't1'").all()
    expect(logs).toHaveLength(0)
  })
})

describe('agent process verification: started-then-died path stays distinguishable', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
  })

  afterEach(() => {
    closeDb(db)
  })

  it('started-then-died agent has a different failure message than never-started', () => {
    // Simulate: agent started (status 'running'), wrote a log, then died (status 'failed')
    db.prepare(
      "INSERT INTO tasks (id, title, status, started_at) VALUES ('t1', 'Test', 'failed', ?)"
    ).run(minutesAgo(2))
    db.prepare(
      "INSERT INTO agents (id, task_id, status) VALUES ('a1', 't1', 'failed')"
    ).run()
    // The agent DID write a progress log before dying — this is NOT never-started
    db.prepare(
      "INSERT INTO logs (task_id, level, message) VALUES ('t1', 'info', 'Task started, working on implementation')"
    ).run()
    // The failure is recorded without AGENT_NEVER_STARTED_REASON
    db.prepare(
      "INSERT INTO logs (task_id, level, message) VALUES ('t1', 'error', 'worker exited unexpectedly')"
    ).run()

    const errorLogs = db.prepare(
      "SELECT message FROM logs WHERE task_id = 't1' AND level = 'error'"
    ).all() as { message: string }[]

    expect(errorLogs).toHaveLength(1)
    expect(errorLogs[0].message).not.toBe(AGENT_NEVER_STARTED_REASON)
    expect(errorLogs[0].message).toBe('worker exited unexpectedly')
  })

  it('never-started path writes exactly AGENT_NEVER_STARTED_REASON, not a generic timeout message', () => {
    db.prepare(
      "INSERT INTO tasks (id, title, status, started_at) VALUES ('t1', 'Test', 'in_progress', ?)"
    ).run(secondsAgo(90))
    db.prepare(
      "INSERT INTO agents (id, task_id, status) VALUES ('a1', 't1', 'spawning')"
    ).run()

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, 5, 10, Date.now(), () => '', () => {}, 60)

    const errorLogs = db.prepare(
      "SELECT message FROM logs WHERE task_id = 't1' AND level = 'error'"
    ).all() as { message: string }[]

    expect(errorLogs).toHaveLength(1)
    expect(errorLogs[0].message).toBe(AGENT_NEVER_STARTED_REASON)
    // Must NOT look like the general timeout message
    expect(errorLogs[0].message).not.toContain('timed out after')
  })

  it('running agent with old log is caught by general staleness (not never-started)', () => {
    // An agent that DID start (status 'running') but has been quiet too long
    // should get the timed-out message, NOT the never-started reason
    db.prepare(
      "INSERT INTO tasks (id, title, status, started_at) VALUES ('t1', 'Test', 'in_progress', ?)"
    ).run(minutesAgo(15))
    db.prepare(
      "INSERT INTO agents (id, task_id, status) VALUES ('a1', 't1', 'running')"
    ).run()
    // Has a log from 12 minutes ago (past both warning and timeout)
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'started', ?)"
    ).run(minutesAgo(12))

    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, 5, 10, Date.now(), () => 'idle', () => {}, 60)

    const errorLogs = db.prepare(
      "SELECT message FROM logs WHERE task_id = 't1' AND level = 'error'"
    ).all() as { message: string }[]

    expect(errorLogs).toHaveLength(1)
    expect(errorLogs[0].message).toContain('timed out after')
    expect(errorLogs[0].message).not.toBe(AGENT_NEVER_STARTED_REASON)
  })
})

describe('agent process verification: first-activity heartbeat parameter', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    db.prepare(
      "INSERT INTO tasks (id, title, status, started_at) VALUES ('t1', 'Test', 'in_progress', ?)"
    ).run(secondsAgo(45))
    db.prepare(
      "INSERT INTO agents (id, task_id, status) VALUES ('a1', 't1', 'spawning')"
    ).run()
  })

  afterEach(() => {
    closeDb(db)
  })

  it('respects a custom firstActivitySeconds threshold', () => {
    // started 45s ago; default threshold is 60s so would NOT trigger
    const stuckSince = new Map<string, number>()
    checkStuckWorkers(db, stuckSince, 5, 10, Date.now(), () => '', () => {}, 60)
    const task1 = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task1.status).toBe('in_progress') // not yet past 60s

    // Lower threshold to 30s — now 45s elapsed should trigger
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 't1'").run()
    db.prepare("UPDATE agents SET status = 'spawning' WHERE id = 'a1'").run()
    checkStuckWorkers(db, stuckSince, 5, 10, Date.now(), () => '', () => {}, 30)
    const task2 = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task2.status).toBe('failed')
  })

  it('does not check spawning agents under the running-agent staleness path', () => {
    // spawning agents should not produce "timed out after Xm" messages
    db.prepare("UPDATE tasks SET started_at = ? WHERE id = 't1'").run(minutesAgo(15))

    const stuckSince = new Map<string, number>()
    // Use a very high firstActivitySeconds so heartbeat doesn't trigger
    checkStuckWorkers(db, stuckSince, 5, 10, Date.now(), () => '', () => {}, 9999)

    const allLogs = db.prepare("SELECT * FROM logs WHERE task_id = 't1'").all()
    expect(allLogs).toHaveLength(0) // spawning agents skipped by running-agent path
  })
})
