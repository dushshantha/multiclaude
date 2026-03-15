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

  it('report_done marks agent status as done', () => {
    // The task was set up with agent_id 'w-1' in beforeEach
    registerAgent(db, { id: 'w-1', task_id: 'task-1' })
    handleReportDone(db, 'task-1', 'done')
    const agent = db.prepare("SELECT status FROM agents WHERE id = 'w-1'").get() as { status: string }
    expect(agent.status).toBe('done')
  })

  it('report_done stores token counts when provided', () => {
    handleReportDone(db, 'task-1', 'done', { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 })
    const task = db.prepare("SELECT input_tokens, output_tokens, total_tokens FROM tasks WHERE id = 'task-1'").get() as {
      input_tokens: number; output_tokens: number; total_tokens: number
    }
    expect(task.input_tokens).toBe(1000)
    expect(task.output_tokens).toBe(500)
    expect(task.total_tokens).toBe(1500)
  })

  it('report_done accepts explicit duration_seconds override', () => {
    handleReportDone(db, 'task-1', 'done', { duration_seconds: 42.5 })
    const task = db.prepare("SELECT duration_seconds FROM tasks WHERE id = 'task-1'").get() as { duration_seconds: number }
    expect(task.duration_seconds).toBe(42.5)
  })

  it('report_done computes cost_usd from token counts and model', () => {
    handleReportDone(db, 'task-1', 'done', { input_tokens: 1_000_000, output_tokens: 1_000_000, model: 'sonnet' })
    const task = db.prepare("SELECT cost_usd FROM tasks WHERE id = 'task-1'").get() as { cost_usd: number }
    expect(task.cost_usd).toBeCloseTo(18.0) // $3/M input + $15/M output
  })

  it('report_done leaves cost_usd null when no token counts provided', () => {
    handleReportDone(db, 'task-1', 'done')
    const task = db.prepare("SELECT cost_usd FROM tasks WHERE id = 'task-1'").get() as { cost_usd: number | null }
    expect(task.cost_usd).toBeNull()
  })

  it('report_done uses task model as fallback when no model option provided', () => {
    updateTask(db, 'task-1', { status: 'in_progress' })
    db.prepare("UPDATE tasks SET model = 'haiku' WHERE id = 'task-1'").run()
    handleReportDone(db, 'task-1', 'done', { input_tokens: 1_000_000, output_tokens: 1_000_000 })
    const task = db.prepare("SELECT cost_usd FROM tasks WHERE id = 'task-1'").get() as { cost_usd: number }
    expect(task.cost_usd).toBeCloseTo(4.8) // haiku pricing
  })
})
