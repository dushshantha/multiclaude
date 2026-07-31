/**
 * Tests for merged_into_run field (#99):
 * - Persisted on task when branch lands on the run integration branch
 * - Null when no merge was attempted (task had no worktree)
 * - Surfaced in get_system_status and wait_for_event
 * - True even when task reaches done via the post_merge_cleanup_failed path
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  mockEnsureIntegrationBranch,
  mockMergeWorktreeBranch,
  mockIsMergedInto,
  mockRemoveWorktree,
  mockKillTmuxWindow,
} = vi.hoisted(() => ({
  mockEnsureIntegrationBranch: vi.fn<() => Promise<void>>(),
  mockMergeWorktreeBranch: vi.fn<() => Promise<void>>(),
  mockIsMergedInto: vi.fn<() => Promise<boolean>>(),
  mockRemoveWorktree: vi.fn<() => Promise<void>>(),
  mockKillTmuxWindow: vi.fn(),
}))

vi.mock('../../src/git/merge.js', () => ({
  ensureIntegrationBranch: mockEnsureIntegrationBranch,
  mergeWorktreeBranch: mockMergeWorktreeBranch,
  isMergedInto: mockIsMergedInto,
  MergeConflictError: class MergeConflictError extends Error {
    taskBranch: string; integBranch: string; conflictedFiles: string[]
    constructor(taskBranch: string, integBranch: string, conflictedFiles: string[]) {
      super(`Merge conflict: ${taskBranch} → ${integBranch}`)
      this.name = 'MergeConflictError'
      this.taskBranch = taskBranch
      this.integBranch = integBranch
      this.conflictedFiles = conflictedFiles
    }
  },
}))

vi.mock('../../src/git/worktree.js', () => ({
  removeWorktree: mockRemoveWorktree,
}))

vi.mock('../../src/spawner/tmux.js', () => ({
  killTmuxWindow: mockKillTmuxWindow,
  captureTmuxPane: vi.fn(() => ''),
  spawnTmuxWorker: vi.fn(),
  ensureTmuxSession: vi.fn(() => 'multiclaude'),
  createTmuxWindow: vi.fn(() => '@1'),
}))

import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask, updateTask, getTask } from '../../src/server/state/tasks.js'
import { handleReportDone } from '../../src/server/tools/worker.js'
import { handleGetSystemStatus, handleWaitForEvent } from '../../src/server/tools/orchestrator.js'
import type Database from 'better-sqlite3'

function setupTaskWithWorktree(db: Database.Database, id = 't1') {
  createTask(db, { id, title: 'Test task' })
  updateTask(db, id, {
    status: 'in_progress',
    worktree_path: '/tmp/fake-worktree',
    branch: 'feature/test',
    head_sha: null, // skip empty-branch check
    repo_path: '/fake/repo',
  })
}

function setupTaskNoWorktree(db: Database.Database, id = 't1') {
  createTask(db, { id, title: 'Test task' })
  updateTask(db, id, { status: 'in_progress' })
}

describe('merged_into_run persistence', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    mockEnsureIntegrationBranch.mockReset().mockResolvedValue(undefined)
    mockMergeWorktreeBranch.mockReset().mockResolvedValue(undefined)
    mockIsMergedInto.mockReset().mockResolvedValue(false)
    mockRemoveWorktree.mockReset().mockResolvedValue(undefined)
    mockKillTmuxWindow.mockReset()
  })

  afterEach(() => { closeDb(db) })

  it('merged_into_run is true when merge succeeds', async () => {
    setupTaskWithWorktree(db)
    mockMergeWorktreeBranch.mockResolvedValue(undefined)

    await handleReportDone(db, 't1', 'feature done')

    const task = getTask(db, 't1')
    expect(task?.status).toBe('done')
    expect(task?.merged_into_run).toBe(true)
  })

  it('merged_into_run is null when task had no worktree (no merge attempted)', async () => {
    setupTaskNoWorktree(db)

    await handleReportDone(db, 't1', 'done')

    const task = getTask(db, 't1')
    expect(task?.status).toBe('done')
    expect(task?.merged_into_run).toBeNull()
  })

  it('merged_into_run is null (absent) when task fails because branch did not land', async () => {
    setupTaskWithWorktree(db)
    mockMergeWorktreeBranch.mockRejectedValue(new Error('merge conflict'))
    mockIsMergedInto.mockResolvedValue(false)

    await handleReportDone(db, 't1', 'done')

    const task = getTask(db, 't1')
    expect(task?.status).toBe('failed')
    expect(task?.merged_into_run).toBeNull()
  })

  it('merged_into_run is true via post_merge_cleanup_failed path (#101)', async () => {
    // mergeWorktreeBranch throws a post-merge error but branch actually landed
    setupTaskWithWorktree(db)
    mockMergeWorktreeBranch.mockRejectedValue(new Error('push to origin failed'))
    mockIsMergedInto.mockResolvedValue(true)

    await handleReportDone(db, 't1', 'done')

    const task = getTask(db, 't1')
    expect(task?.status).toBe('done')
    expect(task?.merged_into_run).toBe(true)
  })

  it('merged_into_run is true even when removeWorktree throws after successful merge', async () => {
    setupTaskWithWorktree(db)
    mockMergeWorktreeBranch.mockResolvedValue(undefined)
    mockRemoveWorktree.mockRejectedValue(new Error('worktree already removed'))

    await handleReportDone(db, 't1', 'done')

    const task = getTask(db, 't1')
    expect(task?.status).toBe('done')
    expect(task?.merged_into_run).toBe(true)
  })
})

describe('merged_into_run in system status output', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('get_system_status includes merged_into_run on each task', () => {
    db.prepare("INSERT INTO tasks (id, title, status, merged_into_run) VALUES ('t1', 'Task', 'done', 1)").run()
    const status = handleGetSystemStatus(db, true)
    const task = status.tasks.find(t => t.id === 't1')
    expect(task).toBeDefined()
    expect('merged_into_run' in task!).toBe(true)
    expect(task!.merged_into_run).toBe(true)
  })

  it('get_system_status surfaces merged_into_run as a JS boolean (not raw 0/1)', () => {
    db.prepare("INSERT INTO tasks (id, title, status, merged_into_run) VALUES ('t1', 'Task', 'done', 1)").run()
    db.prepare("INSERT INTO tasks (id, title, status, merged_into_run) VALUES ('t2', 'Task', 'done', 0)").run()
    const status = handleGetSystemStatus(db, true)
    const t1 = status.tasks.find(t => t.id === 't1')!
    const t2 = status.tasks.find(t => t.id === 't2')!
    expect(t1.merged_into_run).toBe(true)
    expect(typeof t1.merged_into_run).toBe('boolean')
    expect(t2.merged_into_run).toBe(false)
    expect(typeof t2.merged_into_run).toBe('boolean')
  })

  it('get_system_status returns null for tasks with no merged_into_run value', () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'Task', 'done')").run()
    const status = handleGetSystemStatus(db, true)
    const task = status.tasks.find(t => t.id === 't1')!
    expect(task.merged_into_run).toBeNull()
  })

  it('wait_for_event includes merged_into_run in task output', async () => {
    db.prepare("INSERT INTO tasks (id, title, status, merged_into_run) VALUES ('t1', 'Task', 'in_progress', 1)").run()
    setTimeout(() => {
      db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't1'").run()
    }, 200)
    const result = await handleWaitForEvent(db, 5, true)
    const task = result.tasks.find(t => t.id === 't1')
    expect(task).toBeDefined()
    expect(task!.merged_into_run).toBe(true)
  })

  it('wait_for_event surfaces merged_into_run as a JS boolean', async () => {
    db.prepare("INSERT INTO tasks (id, title, status, merged_into_run) VALUES ('t1', 'Task', 'in_progress', 1)").run()
    setTimeout(() => {
      db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't1'").run()
    }, 200)
    const result = await handleWaitForEvent(db, 5, true)
    const task = result.tasks.find(t => t.id === 't1')!
    expect(typeof task.merged_into_run).toBe('boolean')
    expect(task.merged_into_run).toBe(true)
  })
})
