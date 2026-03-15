import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { handlePlanDag, handleGetSystemStatus, handleWaitForEvent, handleCancelTask, handleSpawnWorker } from '../../src/server/tools/orchestrator.js'
import { addEdge } from '../../src/server/state/dag.js'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'

describe('orchestrator tools', () => {
  let db: Database.Database
  let repoPath: string

  beforeEach(() => {
    db = createDb(':memory:')
    repoPath = mkdtempSync(join(tmpdir(), 'mc-orch-test-'))
    execSync('git init', { cwd: repoPath })
    execSync('git config user.email "test@test.com"', { cwd: repoPath })
    execSync('git config user.name "Test"', { cwd: repoPath })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: repoPath })
  })

  afterEach(() => {
    closeDb(db)
    rmSync(repoPath, { recursive: true, force: true })
  })

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
    expect(viz).toContain('API Contract')
    expect(viz).toContain('JWT Impl')
    expect(viz).toContain('OAuth Impl')
    expect(viz).toContain('Wave 1 (runs immediately)')
    expect(viz).toContain('Wave 2')
    expect(viz).toContain('a → b')
    expect(viz).toContain('a → c')
  })

  it('plan_dag stores model field on tasks (defaults to sonnet)', () => {
    const epic = {
      tasks: [
        { id: 'a', title: 'Fast task', model: 'haiku', dependsOn: [] },
        { id: 'b', title: 'Standard task', dependsOn: [] },
        { id: 'c', title: 'Complex task', model: 'opus', dependsOn: [] },
      ]
    }
    handlePlanDag(db, epic)
    const tasks = db.prepare('SELECT id, model FROM tasks ORDER BY id').all() as { id: string; model: string }[]
    expect(tasks.find(t => t.id === 'a')?.model).toBe('haiku')
    expect(tasks.find(t => t.id === 'b')?.model).toBe('sonnet')
    expect(tasks.find(t => t.id === 'c')?.model).toBe('opus')
  })

  it('get_system_status returns tasks, agents, readyTasks, and retriableTasks', () => {
    const status = handleGetSystemStatus(db)
    expect(status).toHaveProperty('tasks')
    expect(status).toHaveProperty('agents')
    expect(status).toHaveProperty('readyTasks')
    expect(status).toHaveProperty('retriableTasks')
    expect(Array.isArray(status.tasks)).toBe(true)
    expect(Array.isArray(status.retriableTasks)).toBe(true)
  })

  it('get_system_status retriableTasks includes only failed tasks with retries remaining', () => {
    db.prepare("INSERT INTO tasks (id, title, status, retry_count, max_retries) VALUES ('t1', 'Task 1', 'failed', 0, 3)").run()
    db.prepare("INSERT INTO tasks (id, title, status, retry_count, max_retries) VALUES ('t2', 'Task 2', 'failed', 3, 3)").run()
    db.prepare("INSERT INTO tasks (id, title, status, retry_count, max_retries) VALUES ('t3', 'Task 3', 'done', 0, 3)").run()
    const status = handleGetSystemStatus(db)
    expect(status.retriableTasks).toHaveLength(1)
    expect(status.retriableTasks[0].id).toBe('t1')
  })

  it('cancel_task marks task as cancelled', () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'test', 'in_progress')").run()
    handleCancelTask(db, 't1')
    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('cancelled')
  })

  it('spawn_worker succeeds when task has no blockers', async () => {
    db.prepare("INSERT INTO tasks (id, title) VALUES ('t1', 'Task 1')").run()
    const result = await handleSpawnWorker(db, 't1', 'w-t1', { cwd: repoPath })
    expect(result.ok).toBe(true)
    const task = db.prepare("SELECT status, agent_id, worktree_path FROM tasks WHERE id = 't1'").get() as { status: string; agent_id: string; worktree_path: string | null }
    expect(task.status).toBe('in_progress')
    expect(task.agent_id).toBe('w-t1')
    expect(task.worktree_path).toBeTruthy()
    const agent = db.prepare("SELECT cwd FROM agents WHERE id = 'w-t1'").get() as { cwd: string }
    expect(agent.cwd).toBe(task.worktree_path)
    if (task.worktree_path) rmSync(task.worktree_path, { recursive: true, force: true })
  })

  it('spawn_worker fails when a blocker is not done', async () => {
    db.prepare("INSERT INTO tasks (id, title) VALUES ('blocker', 'Blocker')").run()
    db.prepare("INSERT INTO tasks (id, title) VALUES ('dependent', 'Dependent')").run()
    addEdge(db, 'blocker', 'dependent')
    const result = await handleSpawnWorker(db, 'dependent', 'w-dep')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain('blocker')
  })

  it('spawn_worker succeeds when all blockers are done', async () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('blocker', 'Blocker', 'done')").run()
    db.prepare("INSERT INTO tasks (id, title) VALUES ('dependent', 'Dependent')").run()
    addEdge(db, 'blocker', 'dependent')
    const result = await handleSpawnWorker(db, 'dependent', 'w-dep')
    expect(result.ok).toBe(true)
  })

  it('spawn_worker blocks when run budget is exceeded', async () => {
    // Create project and run with budget
    db.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p1', 'test', '/test')").run()
    db.prepare("INSERT INTO runs (id, project_id, title, budget_usd) VALUES ('r1', 'p1', 'Test Run', 0.001)").run()
    // Create a done task that already spent $0.002 (over budget)
    db.prepare("INSERT INTO tasks (id, title, status, run_id, cost_usd) VALUES ('done-1', 'Done Task', 'done', 'r1', 0.002)").run()
    // New task to spawn
    db.prepare("INSERT INTO tasks (id, title, run_id) VALUES ('new-1', 'New Task', 'r1')").run()
    const result = await handleSpawnWorker(db, 'new-1', 'w-new-1')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain('budget')
  })

  it('spawn_worker proceeds when run has budget and cost is within limit', async () => {
    db.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p1', 'test', '/test')").run()
    db.prepare("INSERT INTO runs (id, project_id, title, budget_usd) VALUES ('r1', 'p1', 'Test Run', 1.0)").run()
    db.prepare("INSERT INTO tasks (id, title, status, run_id, cost_usd) VALUES ('done-1', 'Done Task', 'done', 'r1', 0.001)").run()
    db.prepare("INSERT INTO tasks (id, title, run_id) VALUES ('new-1', 'New Task', 'r1')").run()
    const result = await handleSpawnWorker(db, 'new-1', 'w-new-1')
    expect(result.ok).toBe(true)
  })

  it('wait_for_event returns immediately when status changes during wait', async () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'Task', 'pending')").run()
    setTimeout(() => {
      db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't1'").run()
    }, 200)
    const start = Date.now()
    await handleWaitForEvent(db, 5)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2000)
    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('done')
  })

  it('wait_for_event returns after timeout when nothing changes', async () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'Task', 'pending')").run()
    const start = Date.now()
    await handleWaitForEvent(db, 2)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(2000)
    expect(elapsed).toBeLessThan(4000)
  })
})
