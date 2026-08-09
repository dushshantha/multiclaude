import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { handlePlanDag, handleGetSystemStatus, handleWaitForEvent, handleCancelTask, handleSpawnWorker, normalizeEffort, VALID_EFFORT_VALUES, enrichWithLastLog } from '../../src/server/tools/orchestrator.js'
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

  it('plan_dag stores effort field on tasks (defaults to high)', () => {
    const epic = {
      tasks: [
        { id: 'a', title: 'Low effort task', effort: 'low', dependsOn: [] },
        { id: 'b', title: 'Default effort task', dependsOn: [] },
        { id: 'c', title: 'Max effort task', effort: 'max', dependsOn: [] },
      ]
    }
    handlePlanDag(db, epic)
    const tasks = db.prepare('SELECT id, effort FROM tasks ORDER BY id').all() as { id: string; effort: string }[]
    expect(tasks.find(t => t.id === 'a')?.effort).toBe('low')
    expect(tasks.find(t => t.id === 'b')?.effort).toBe('high')
    expect(tasks.find(t => t.id === 'c')?.effort).toBe('max')
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

  it('spawn_worker does not overwrite a good repo_path when handed a worktree path', async () => {
    // Simulate the retry-loop scenario: task already has repo_path set to the main checkout,
    // but spawn is called with a temp worktree path as cwd.
    const worktreePath = mkdtempSync(join(tmpdir(), 'mc-orch-wt-'))
    try {
      execSync(`git worktree add ${worktreePath} -b guard-test-branch`, { cwd: repoPath })
      db.prepare("INSERT INTO tasks (id, title, repo_path) VALUES ('guard-t1', 'Guard Task', ?)")
        .run(repoPath)

      const result = await handleSpawnWorker(db, 'guard-t1', 'w-guard-t1', { cwd: worktreePath })
      expect(result.ok).toBe(true)

      const task = db.prepare("SELECT repo_path, worktree_path FROM tasks WHERE id = 'guard-t1'").get() as {
        repo_path: string; worktree_path: string | null
      }
      // repo_path must still point to the main checkout, not the worktree
      expect(task.repo_path).toBe(repoPath)
      expect(task.worktree_path).toBeTruthy()
      if (task.worktree_path) rmSync(task.worktree_path, { recursive: true, force: true })
    } finally {
      execSync(`git worktree remove --force ${worktreePath}`, { cwd: repoPath }).toString()
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })

  it('spawn_worker fails with repo_path_invalid when cwd is a worktree and task has no repo_path', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'mc-orch-wt-invalid-'))
    try {
      execSync(`git worktree add ${worktreePath} -b guard-invalid-branch`, { cwd: repoPath })
      db.prepare("INSERT INTO tasks (id, title) VALUES ('guard-t2', 'Guard Task 2')").run()

      const result = await handleSpawnWorker(db, 'guard-t2', 'w-guard-t2', { cwd: worktreePath })
      expect(result.ok).toBe(false)
      expect((result as { ok: false; error: string }).error).toContain('not a main git checkout')

      const task = db.prepare("SELECT status, failure_reason FROM tasks WHERE id = 'guard-t2'").get() as {
        status: string; failure_reason: string
      }
      expect(task.status).toBe('failed')
      expect(task.failure_reason).toBe('repo_path_invalid')
    } finally {
      execSync(`git worktree remove --force ${worktreePath}`, { cwd: repoPath })
      rmSync(worktreePath, { recursive: true, force: true })
    }
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

  // Zod schema mirroring index.ts plan_dag epic parameter with z.preprocess coercion
  const epicSchema = z.preprocess(
    (val) => typeof val === 'string' ? JSON.parse(val) : val,
    z.object({
      tasks: z.preprocess(
        (val) => typeof val === 'string' ? JSON.parse(val) : val,
        z.array(z.object({
          id: z.string(),
          title: z.string(),
          description: z.string().optional(),
          model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
          ticket: z.string().optional(),
          dependsOn: z.array(z.string()),
        }))
      ),
      run_id: z.string().optional(),
      cwd: z.string().optional(),
    })
  )

  it('plan_dag works when epic is a plain object', () => {
    const epic = { tasks: [{ id: 'x1', title: 'Plain Task', dependsOn: [] }] }
    const parsed = epicSchema.parse(epic)
    const result = handlePlanDag(db, parsed)
    expect('visualization' in result).toBe(true)
  })

  it('plan_dag works when epic is a JSON string', () => {
    const epicStr = JSON.stringify({ tasks: [{ id: 'x2', title: 'String Epic Task', dependsOn: [] }] })
    const parsed = epicSchema.parse(epicStr)
    const result = handlePlanDag(db, parsed)
    expect('visualization' in result).toBe(true)
    expect((result as { visualization: string }).visualization).toContain('String Epic Task')
  })

  it('plan_dag works when tasks is a JSON string inside a valid epic object', () => {
    const epic = { tasks: JSON.stringify([{ id: 'x3', title: 'String Tasks Task', dependsOn: [] }]) }
    const parsed = epicSchema.parse(epic)
    const result = handlePlanDag(db, parsed)
    expect('visualization' in result).toBe(true)
    expect((result as { visualization: string }).visualization).toContain('String Tasks Task')
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

describe('effort canonicalization', () => {
  it('normalizeEffort returns canonical value for each valid effort', () => {
    for (const v of VALID_EFFORT_VALUES) {
      expect(normalizeEffort(v)).toBe(v)
    }
  })

  it('normalizeEffort normalises "extra" alias to "xhigh"', () => {
    expect(normalizeEffort('extra')).toBe('xhigh')
  })

  it('normalizeEffort returns null for invalid effort values', () => {
    expect(normalizeEffort('turbo')).toBeNull()
    expect(normalizeEffort('ultra')).toBeNull()
    expect(normalizeEffort('')).toBeNull()
    expect(normalizeEffort('HIGH')).toBeNull()
  })

  describe('plan_dag effort integration', () => {
    let db: ReturnType<typeof createDb>

    beforeEach(() => { db = createDb(':memory:') })
    afterEach(() => { closeDb(db) })

    it('stores "xhigh" when effort is explicitly set to "xhigh"', () => {
      handlePlanDag(db, { tasks: [{ id: 't1', title: 'Task', effort: 'xhigh', dependsOn: [] }] })
      const row = db.prepare('SELECT effort FROM tasks WHERE id = ?').get('t1') as { effort: string }
      expect(row.effort).toBe('xhigh')
    })

    it('normalises "extra" to "xhigh" before writing the task record', () => {
      handlePlanDag(db, { tasks: [{ id: 't1', title: 'Task', effort: 'extra', dependsOn: [] }] })
      const row = db.prepare('SELECT effort FROM tasks WHERE id = ?').get('t1') as { effort: string }
      expect(row.effort).toBe('xhigh')
    })

    it('returns an error for an invalid effort value naming the valid set', () => {
      const result = handlePlanDag(db, { tasks: [{ id: 't1', title: 'Task', effort: 'turbo', dependsOn: [] }] })
      expect('error' in result).toBe(true)
      const { error } = result as { error: string }
      expect(error).toContain('turbo')
      expect(error).toContain('xhigh')
      expect(error).toContain('low')
      expect(error).toContain('max')
    })

    it('accepts all canonical effort values and stores them unchanged', () => {
      const tasks = VALID_EFFORT_VALUES.map((v, i) => ({ id: `t${i}`, title: `Task ${v}`, effort: v, dependsOn: [] }))
      const result = handlePlanDag(db, { tasks })
      expect('visualization' in result).toBe(true)
      for (const [i, v] of VALID_EFFORT_VALUES.entries()) {
        const row = db.prepare('SELECT effort FROM tasks WHERE id = ?').get(`t${i}`) as { effort: string }
        expect(row.effort).toBe(v)
      }
    })

    it('does not write "extra" to the task record — always normalises to "xhigh"', () => {
      handlePlanDag(db, { tasks: [{ id: 't1', title: 'Task', effort: 'extra', dependsOn: [] }] })
      const row = db.prepare('SELECT effort FROM tasks WHERE id = ?').get('t1') as { effort: string }
      expect(row.effort).not.toBe('extra')
    })
  })
})

describe('last_log_at heartbeat field in system status', () => {
  let db: ReturnType<typeof createDb>

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('get_system_status includes last_log_at on each task', () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'Task', 'in_progress')").run()
    const status = handleGetSystemStatus(db, true)
    expect(status.tasks).toHaveLength(1)
    expect('last_log_at' in status.tasks[0]).toBe(true)
  })

  it('last_log_at is null when no log entries exist (agent merely registered)', () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'Task', 'in_progress')").run()
    const status = handleGetSystemStatus(db, true)
    expect(status.tasks[0].last_log_at).toBeNull()
  })

  it('last_log_at reflects the most recent log entry timestamp', () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'Task', 'in_progress')").run()
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'started', '2026-01-01T10:00:00.000Z')"
    ).run()
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'progress', '2026-01-01T10:05:00.000Z')"
    ).run()

    const status = handleGetSystemStatus(db, true)
    expect(status.tasks[0].last_log_at).toBe('2026-01-01T10:05:00.000Z')
  })

  it('last_log_at appears on retriableTasks as well', () => {
    db.prepare(
      "INSERT INTO tasks (id, title, status, retry_count, max_retries) VALUES ('t1', 'Task', 'failed', 0, 3)"
    ).run()
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'error', 'oops', '2026-01-01T09:00:00.000Z')"
    ).run()

    const status = handleGetSystemStatus(db, true)
    expect(status.retriableTasks).toHaveLength(1)
    expect(status.retriableTasks[0].last_log_at).toBe('2026-01-01T09:00:00.000Z')
  })

  it('enrichWithLastLog returns null for tasks with no logs', () => {
    db.prepare("INSERT INTO tasks (id, title) VALUES ('t1', 'Task')").run()
    const tasks = db.prepare('SELECT * FROM tasks').all() as Parameters<typeof enrichWithLastLog>[1]
    const enriched = enrichWithLastLog(db, tasks)
    expect(enriched[0].last_log_at).toBeNull()
  })

  it('enrichWithLastLog returns non-null for tasks with logs', () => {
    db.prepare("INSERT INTO tasks (id, title) VALUES ('t1', 'Task')").run()
    db.prepare(
      "INSERT INTO logs (task_id, level, message) VALUES ('t1', 'info', 'doing work')"
    ).run()
    const tasks = db.prepare('SELECT * FROM tasks').all() as Parameters<typeof enrichWithLastLog>[1]
    const enriched = enrichWithLastLog(db, tasks)
    expect(enriched[0].last_log_at).not.toBeNull()
  })

  it('last_log_at is task-specific — different tasks have independent values', () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'Task 1', 'in_progress')").run()
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t2', 'Task 2', 'in_progress')").run()
    db.prepare(
      "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'progress', '2026-01-01T12:00:00.000Z')"
    ).run()
    // t2 has no logs

    const status = handleGetSystemStatus(db, true)
    const t1 = status.tasks.find(t => t.id === 't1')!
    const t2 = status.tasks.find(t => t.id === 't2')!
    expect(t1.last_log_at).toBe('2026-01-01T12:00:00.000Z')
    expect(t2.last_log_at).toBeNull()
  })
})
