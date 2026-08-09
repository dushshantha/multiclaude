import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { startVerifyAgentStarted, AGENT_NEVER_STARTED_REASON } from '../../src/spawner/stuck-watcher.js'
import type Database from 'better-sqlite3'

// Small attempt count for fast synchronous tests
const MAX_TEST_ATTEMPTS = 3

describe('startVerifyAgentStarted', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'Test', 'in_progress')").run()
    db.prepare("INSERT INTO agents (id, task_id, status, pid) VALUES ('a1', 't1', 'spawning', 100)").run()
  })

  afterEach(() => {
    closeDb(db)
  })

  // Returns a scheduler that queues callbacks synchronously (no real timers).
  const makeScheduler = () => {
    const queue: (() => void)[] = []
    const schedule = (fn: () => void, _ms: number) => { queue.push(fn) }
    const runNext = () => { queue.shift()?.() }
    return { schedule, runNext, queue }
  }

  it('records child pid and stops when child process is found on first poll', () => {
    const { schedule, runNext } = makeScheduler()
    startVerifyAgentStarted(db, 100, 'a1', 't1', '@1',
      () => 42,    // child pid found immediately
      () => '',    // capturePane (not reached)
      () => {},    // killWindow (not reached)
      schedule, MAX_TEST_ATTEMPTS, 50, 0,
    )
    runNext()
    const agent = db.prepare("SELECT pid FROM agents WHERE id = 'a1'").get() as { pid: number }
    expect(agent.pid).toBe(42)
    // Should not have scheduled another poll
    expect(makeScheduler().queue).toHaveLength(0)
  })

  it('does not mark failed when pane is busy after exhausting attempts', () => {
    const { schedule, runNext, queue } = makeScheduler()
    const killed: string[] = []
    startVerifyAgentStarted(db, 100, 'a1', 't1', '@1',
      () => undefined,          // no child process found
      () => 'esc to interrupt', // pane shows busy footer
      (id) => killed.push(id),
      schedule, MAX_TEST_ATTEMPTS, 50, 0,
    )

    // Run through all MAX_TEST_ATTEMPTS polls — the last one hits the pane check
    for (let i = 0; i < MAX_TEST_ATTEMPTS; i++) runNext()

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    const agent = db.prepare("SELECT status FROM agents WHERE id = 'a1'").get() as { status: string }
    expect(task.status).toBe('in_progress')   // not failed
    expect(agent.status).toBe('spawning')     // not failed
    expect(killed).toHaveLength(0)            // window not killed
    expect(queue).toHaveLength(1)             // counter reset, another poll queued
  })

  it('does not mark failed when pane shows "working..." footer', () => {
    const { schedule, runNext } = makeScheduler()
    const killed: string[] = []
    startVerifyAgentStarted(db, 100, 'a1', 't1', '@1',
      () => undefined,
      () => 'working...',
      (id) => killed.push(id),
      schedule, MAX_TEST_ATTEMPTS, 50, 0,
    )
    for (let i = 0; i < MAX_TEST_ATTEMPTS; i++) runNext()

    const agent = db.prepare("SELECT status FROM agents WHERE id = 'a1'").get() as { status: string }
    expect(agent.status).toBe('spawning')
    expect(killed).toHaveLength(0)
  })

  it('marks task and agent failed when pane is idle after exhausting attempts', () => {
    const { schedule, runNext } = makeScheduler()
    const killed: string[] = []
    startVerifyAgentStarted(db, 100, 'a1', 't1', '@1',
      () => undefined,
      () => 'idle output, no busy footer',
      (id) => killed.push(id),
      schedule, MAX_TEST_ATTEMPTS, 50, 0,
    )

    for (let i = 0; i < MAX_TEST_ATTEMPTS; i++) runNext()

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    const agent = db.prepare("SELECT status FROM agents WHERE id = 'a1'").get() as { status: string }
    expect(task.status).toBe('failed')
    expect(agent.status).toBe('failed')
    expect(killed).toEqual(['@1'])
  })

  it('writes AGENT_NEVER_STARTED_REASON to logs on failure', () => {
    const { schedule, runNext } = makeScheduler()
    startVerifyAgentStarted(db, 100, 'a1', 't1', '@1',
      () => undefined,
      () => '',
      () => {},
      schedule, MAX_TEST_ATTEMPTS, 50, 0,
    )
    for (let i = 0; i < MAX_TEST_ATTEMPTS; i++) runNext()

    const logs = db.prepare(
      "SELECT message FROM logs WHERE task_id = 't1' AND level = 'error'"
    ).all() as { message: string }[]
    expect(logs).toHaveLength(1)
    expect(logs[0].message).toBe(AGENT_NEVER_STARTED_REASON)
  })

  it('stops polling when agent is no longer spawning', () => {
    const { schedule, runNext } = makeScheduler()
    const killed: string[] = []
    startVerifyAgentStarted(db, 100, 'a1', 't1', '@1',
      () => undefined,
      () => '',
      (id) => killed.push(id),
      schedule, MAX_TEST_ATTEMPTS, 50, 0,
    )

    // Mark agent running before the first poll fires
    db.prepare("UPDATE agents SET status = 'running' WHERE id = 'a1'").run()
    runNext()

    const agent = db.prepare("SELECT status FROM agents WHERE id = 'a1'").get() as { status: string }
    expect(agent.status).toBe('running')
    expect(killed).toHaveLength(0)
  })

  it('resets attempt counter after busy-footer detection and eventually fails when pane goes idle', () => {
    const { schedule, runNext } = makeScheduler()
    const killed: string[] = []
    let captureCount = 0
    // First capture returns busy; second returns idle
    const capturePane = () => {
      captureCount++
      return captureCount === 1 ? 'esc to interrupt' : 'idle'
    }
    startVerifyAgentStarted(db, 100, 'a1', 't1', '@1',
      () => undefined,
      capturePane,
      (id) => killed.push(id),
      schedule, MAX_TEST_ATTEMPTS, 50, 0,
    )

    // First full window: busy → resets, re-queues
    for (let i = 0; i < MAX_TEST_ATTEMPTS; i++) runNext()
    expect(killed).toHaveLength(0)  // busy saved it

    // Second full window: idle → fails
    for (let i = 0; i < MAX_TEST_ATTEMPTS; i++) runNext()
    expect(killed).toEqual(['@1'])

    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('failed')
  })
})
