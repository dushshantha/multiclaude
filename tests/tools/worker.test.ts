import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask, updateTask } from '../../src/server/state/tasks.js'
import { registerAgent } from '../../src/server/state/agents.js'
import {
  handleGetMyTask,
  handleReportProgress,
  handleReportDone,
  handleReportBlocked,
} from '../../src/server/tools/worker.js'
import type Database from 'better-sqlite3'

describe('worker tools', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    createTask(db, { id: 'task-1', title: 'JWT auth', description: 'Build JWT' })
    updateTask(db, 'task-1', { status: 'in_progress', agent_id: 'w-1' })
  })

  afterEach(() => { closeDb(db) })

  it('get_my_task returns task for agent', () => {
    const result = handleGetMyTask(db, 'w-1')
    expect(result.id).toBe('task-1')
    expect(result.title).toBe('JWT auth')
  })

  it('report_progress writes a log entry', () => {
    handleReportProgress(db, 'w-1', 'task-1', 'running tests')
    const log = db.prepare('SELECT * FROM logs WHERE task_id = ?').get('task-1') as { message: string }
    expect(log.message).toBe('running tests')
  })

  it('report_done marks task as done', () => {
    handleReportDone(db, 'task-1', 'JWT auth complete, all tests pass')
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string }
    expect(task.status).toBe('done')
  })

  it('report_blocked increments retry_count when under limit', () => {
    const result = handleReportBlocked(db, 'task-1', 'test failure', 'npm test failed')
    expect(result.action).toBe('retry')
    const task = db.prepare("SELECT retry_count FROM tasks WHERE id = 'task-1'").get() as { retry_count: number }
    expect(task.retry_count).toBe(1)
  })

  it('report_blocked returns escalate when retries exhausted', () => {
    updateTask(db, 'task-1', { retry_count: 3 })
    const result = handleReportBlocked(db, 'task-1', 'test failure', 'npm test failed')
    expect(result.action).toBe('escalate')
  })

  it('get_my_task transitions agent status from spawning to running', () => {
    // Register agent as spawning (default status)
    registerAgent(db, { id: 'w-1', task_id: 'task-1' })
    const before = db.prepare("SELECT status FROM agents WHERE id = 'w-1'").get() as { status: string }
    expect(before.status).toBe('spawning')

    handleGetMyTask(db, 'w-1')

    const after = db.prepare("SELECT status FROM agents WHERE id = 'w-1'").get() as { status: string }
    expect(after.status).toBe('running')
  })
})
