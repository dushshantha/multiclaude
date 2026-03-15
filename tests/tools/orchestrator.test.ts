import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { handlePlanDag, handleGetSystemStatus, handleWaitForEvent, handleCancelTask, handleSpawnWorker } from '../../src/server/tools/orchestrator.js'
import { addEdge } from '../../src/server/state/dag.js'
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
    const result = handlePlanDag(db, epic)
    expect('visualization' in result).toBe(true)
    const viz = (result as { visualization: string }).visualization
    const tasks = db.prepare('SELECT * FROM tasks').all() as { id: string }[]
    expect(tasks).toHaveLength(3)
    const edges = db.prepare('SELECT * FROM dag_edges').all() as { from_task: string; to_task: string }[]
    expect(edges).toHaveLength(2)
    expect(edges.find(e => e.from_task === 'a' && e.to_task === 'b')).toBeTruthy()
    expect(edges.find(e => e.from_task === 'a' && e.to_task === 'c')).toBeTruthy()
    // Visualization includes all task titles
    expect(viz).toContain('API Contract')
    expect(viz).toContain('JWT Impl')
    expect(viz).toContain('OAuth Impl')
    // Wave structure
    expect(viz).toContain('Wave 1 (runs immediately)')
    expect(viz).toContain('Wave 2')
    // Dependency edges
    expect(viz).toContain('a → b')
    expect(viz).toContain('a → c')
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

  it('get_system_status retriableTasks includes only failed tasks with retries remaining', () => {
    db.prepare("INSERT INTO tasks (id, title, status, retry_count, max_retries) VALUES ('t1', 'Task 1', 'failed', 0, 3)").run()
    db.prepare("INSERT INTO tasks (id, title, status, retry_count, max_retries) VALUES ('t2', 'Task 2', 'failed', 3, 3)").run()
    db.prepare("INSERT INTO tasks (id, title, status, retry_count, max_retries) VALUES ('t3', 'Task 3', 'done', 0, 3)").run()
    const status = handleGetSystemStatus(db, true)
    expect(status).toHaveProperty('retriableTasks')
    expect(status.retriableTasks).toHaveLength(1)
    expect(status.retriableTasks[0].id).toBe('t1')
  })

  it('spawn_worker succeeds when task has no blockers', () => {
    db.prepare("INSERT INTO tasks (id, title) VALUES ('t1', 'Task 1')").run()
    const result = handleSpawnWorker(db, 't1', 'w-t1', { cwd: '/tmp' })
    expect(result.ok).toBe(true)
    const task = db.prepare("SELECT status, agent_id FROM tasks WHERE id = 't1'").get() as { status: string; agent_id: string }
    expect(task.status).toBe('in_progress')
    expect(task.agent_id).toBe('w-t1')
    const agent = db.prepare("SELECT cwd FROM agents WHERE id = 'w-t1'").get() as { cwd: string }
    expect(agent.cwd).toBe('/tmp')
  })

  it('spawn_worker fails when a blocker is not done', () => {
    db.prepare("INSERT INTO tasks (id, title) VALUES ('blocker', 'Blocker')").run()
    db.prepare("INSERT INTO tasks (id, title) VALUES ('dependent', 'Dependent')").run()
    addEdge(db, 'blocker', 'dependent')
    const result = handleSpawnWorker(db, 'dependent', 'w-dep')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain('blocker')
  })

  it('spawn_worker succeeds when all blockers are done', () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('blocker', 'Blocker', 'done')").run()
    db.prepare("INSERT INTO tasks (id, title) VALUES ('dependent', 'Dependent')").run()
    addEdge(db, 'blocker', 'dependent')
    const result = handleSpawnWorker(db, 'dependent', 'w-dep')
    expect(result.ok).toBe(true)
  })

  it('wait_for_event returns immediately when status changes during wait', async () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'Task', 'pending')").run()

    // Change the status after 200ms
    setTimeout(() => {
      db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't1'").run()
    }, 200)

    const start = Date.now()
    const result = await handleWaitForEvent(db, 5, true) // include_done=true to see the completed task
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(2000) // resolved well before 5s timeout
    expect(result.tasks[0].status).toBe('done')
  })

  it('wait_for_event returns after timeout when nothing changes', async () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'Task', 'pending')").run()

    const start = Date.now()
    await handleWaitForEvent(db, 2) // 2-second timeout
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(2000)
    expect(elapsed).toBeLessThan(4000)
  })
})
