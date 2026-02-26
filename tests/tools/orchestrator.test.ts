import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { handlePlanDag, handleGetSystemStatus, handleCancelTask } from '../../src/server/tools/orchestrator.js'
import type Database from 'better-sqlite3'

describe('orchestrator tools', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('plan_dag creates tasks and edges from epic', () => {
    const epic = {
      tasks: [
        { id: 'a', title: 'API Contract', dependsOn: [] },
        { id: 'b', title: 'JWT Impl', dependsOn: ['a'] },
        { id: 'c', title: 'OAuth Impl', dependsOn: ['a'] },
      ]
    }
    handlePlanDag(db, epic)
    const tasks = db.prepare('SELECT * FROM tasks').all() as { id: string }[]
    expect(tasks).toHaveLength(3)
    const edges = db.prepare('SELECT * FROM dag_edges').all() as { from_task: string; to_task: string }[]
    expect(edges).toHaveLength(2)
    expect(edges.find(e => e.from_task === 'a' && e.to_task === 'b')).toBeTruthy()
    expect(edges.find(e => e.from_task === 'a' && e.to_task === 'c')).toBeTruthy()
  })

  it('get_system_status returns tasks, agents, and readyTasks', () => {
    const status = handleGetSystemStatus(db)
    expect(status).toHaveProperty('tasks')
    expect(status).toHaveProperty('agents')
    expect(status).toHaveProperty('readyTasks')
    expect(Array.isArray(status.tasks)).toBe(true)
  })

  it('cancel_task marks task as cancelled', () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'test', 'in_progress')").run()
    handleCancelTask(db, 't1')
    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('cancelled')
  })
})
