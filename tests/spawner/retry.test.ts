import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask, getTask, updateTask, listTasks } from '../../src/server/state/tasks.js'
import { registerAgent, updateAgent } from '../../src/server/state/agents.js'
import { createWorktree, removeWorktree } from '../../src/git/worktree.js'
import { handleSpawnWorker } from '../../src/server/tools/orchestrator.js'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'

describe('worker retry: task status on early exit', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
  })

  afterEach(() => {
    closeDb(db)
  })

  it('task transitions to failed when worker exits without report_done', () => {
    // Simulate: task is in_progress, agent is running, then worker process exits
    createTask(db, { id: 'task-exit', title: 'Test task' })
    updateTask(db, 'task-exit', { status: 'in_progress', agent_id: 'w-task-exit' })
    registerAgent(db, { id: 'w-task-exit', task_id: 'task-exit', cwd: '/tmp/fake' })
    updateAgent(db, 'w-task-exit', { status: 'running' })

    // Replicate the onExit logic from cli.ts: agent is running/spawning -> mark failed
    const current = db.prepare(
      "SELECT status FROM agents WHERE id = ?"
    ).get('w-task-exit') as { status: string } | undefined
    if (current?.status === 'running' || current?.status === 'spawning') {
      updateAgent(db, 'w-task-exit', { status: 'failed' })
      const t = getTask(db, 'task-exit')
      if (t && t.status !== 'done') {
        updateTask(db, 'task-exit', { status: 'failed' })
      }
    }

    const task = getTask(db, 'task-exit')!
    expect(task.status).toBe('failed')
  })

  it('task is NOT marked failed if it already reached done (graceful report_done)', () => {
    createTask(db, { id: 'task-done', title: 'Done task' })
    updateTask(db, 'task-done', { status: 'done', agent_id: 'w-task-done' })
    registerAgent(db, { id: 'w-task-done', task_id: 'task-done', cwd: '/tmp/fake' })
    updateAgent(db, 'w-task-done', { status: 'running' })

    // Replicate onExit logic — agent still shows 'running' because report_done
    // updates task status but the agent transitions to 'done' separately
    const current = db.prepare(
      "SELECT status FROM agents WHERE id = ?"
    ).get('w-task-done') as { status: string } | undefined
    if (current?.status === 'running' || current?.status === 'spawning') {
      updateAgent(db, 'w-task-done', { status: 'failed' })
      const t = getTask(db, 'task-done')
      if (t && t.status !== 'done') {
        updateTask(db, 'task-done', { status: 'failed' })
      }
    }

    const task = getTask(db, 'task-done')!
    expect(task.status).toBe('done')
  })

  it('failed task becomes retriable and retry_count increments', () => {
    createTask(db, { id: 'task-retry', title: 'Retriable task', max_retries: 3 })
    updateTask(db, 'task-retry', { status: 'failed' })

    // Simulate the auto-retry loop from cli.ts
    const failedTasks = listTasks(db, 'failed').filter(t => t.retry_count < t.max_retries)
    expect(failedTasks).toHaveLength(1)
    expect(failedTasks[0].id).toBe('task-retry')

    // Retry: increment retry_count, reset to pending
    updateTask(db, 'task-retry', { retry_count: 1, status: 'pending' })

    const updated = getTask(db, 'task-retry')!
    expect(updated.retry_count).toBe(1)
    expect(updated.status).toBe('pending')
  })

  it('onError handler also marks task failed', () => {
    createTask(db, { id: 'task-err', title: 'Error task' })
    updateTask(db, 'task-err', { status: 'in_progress', agent_id: 'w-task-err' })
    registerAgent(db, { id: 'w-task-err', task_id: 'task-err', cwd: '/tmp/fake' })
    updateAgent(db, 'w-task-err', { status: 'spawning' })

    // Replicate onError logic
    updateAgent(db, 'w-task-err', { status: 'failed' })
    const t = getTask(db, 'task-err')
    if (t && t.status !== 'done') {
      updateTask(db, 'task-err', { status: 'failed' })
    }

    expect(getTask(db, 'task-err')!.status).toBe('failed')
  })
})

describe('worker retry: worktree/branch collision on retry', () => {
  let repoPath: string

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'mc-retry-wt-'))
    execSync('git init', { cwd: repoPath })
    execSync('git config user.email "test@test.com"', { cwd: repoPath })
    execSync('git config user.name "Test"', { cwd: repoPath })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: repoPath })
  })

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('createWorktree succeeds when branch already exists from prior failed attempt', async () => {
    // First attempt: create worktree (simulates initial spawn)
    const info1 = await createWorktree(repoPath, 'task-collision')
    expect(info1.branch).toBe('mc/task-collision')

    // Simulate worker dying: worktree and branch are left behind
    // (We do NOT call removeWorktree — that's the bug scenario)

    // Second attempt: createWorktree should clean up and succeed (retry)
    const info2 = await createWorktree(repoPath, 'task-collision')
    expect(info2.branch).toBe('mc/task-collision')
    expect(info2.path).not.toBe(info1.path) // new temp path

    // Verify the new worktree is functional
    const worktrees = execSync('git worktree list', { cwd: repoPath }).toString()
    expect(worktrees).toContain(info2.path)

    // Cleanup
    await removeWorktree(repoPath, info2)
    // Also remove the now-orphaned first path
    rmSync(info1.path, { recursive: true, force: true })
  })

  it('createWorktree succeeds when branch exists but worktree was already removed', async () => {
    // Create a branch manually (simulates leftover branch, no worktree)
    execSync(`git branch mc/task-orphan`, { cwd: repoPath })

    // createWorktree should clean up the orphan branch and succeed
    const info = await createWorktree(repoPath, 'task-orphan')
    expect(info.branch).toBe('mc/task-orphan')

    const worktrees = execSync('git worktree list', { cwd: repoPath }).toString()
    expect(worktrees).toContain(info.path)

    await removeWorktree(repoPath, info)
  })

  it('handleSpawnWorker succeeds on retry after prior failed worktree', async () => {
    const db = createDb(':memory:')
    try {
      createTask(db, { id: 'task-spawn-retry', title: 'Spawn retry test' })

      // First spawn — creates worktree
      const result1 = await handleSpawnWorker(db, 'task-spawn-retry', 'w-1', { cwd: repoPath })
      expect(result1.ok).toBe(true)

      const task1 = getTask(db, 'task-spawn-retry')!
      const worktree1 = task1.worktree_path!

      // Simulate failure: mark task as failed, increment retry_count, reset to pending
      updateTask(db, 'task-spawn-retry', { status: 'failed' })
      updateTask(db, 'task-spawn-retry', { retry_count: 1, status: 'pending' })

      // Retry spawn — should NOT collide on existing branch
      const result2 = await handleSpawnWorker(db, 'task-spawn-retry', 'w-2', { cwd: repoPath })
      expect(result2.ok).toBe(true)

      const task2 = getTask(db, 'task-spawn-retry')!
      expect(task2.status).toBe('in_progress')
      expect(task2.worktree_path).not.toBe(worktree1)

      // Cleanup
      if (task2.worktree_path) rmSync(task2.worktree_path, { recursive: true, force: true })
      rmSync(worktree1, { recursive: true, force: true })
    } finally {
      closeDb(db)
    }
  })
})
