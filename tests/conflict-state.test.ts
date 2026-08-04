/**
 * Tests for conflict state persistence:
 * - conflicted_files and conflict_branch round-trip through the DB
 * - handleReportDone MergeConflictError path sets the right fields and preserves the branch
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

vi.mock('../src/git/merge.js', () => ({
  ensureIntegrationBranch: mockEnsureIntegrationBranch,
  mergeWorktreeBranch: mockMergeWorktreeBranch,
  isMergedInto: mockIsMergedInto,
  MergeConflictError: class MergeConflictError extends Error {
    taskBranch: string; integBranch: string; conflictedFiles: string[]
    constructor(taskBranch: string, integBranch: string, conflictedFiles: string[]) {
      super(`Merge conflict: ${taskBranch} cannot be merged into ${integBranch} — conflicted files: ${conflictedFiles.join(', ')}`)
      this.name = 'MergeConflictError'
      this.taskBranch = taskBranch
      this.integBranch = integBranch
      this.conflictedFiles = conflictedFiles
    }
  },
}))

vi.mock('../src/git/worktree.js', () => ({
  removeWorktree: mockRemoveWorktree,
}))

vi.mock('../src/spawner/tmux.js', () => ({
  killTmuxWindow: mockKillTmuxWindow,
  captureTmuxPane: vi.fn(() => ''),
  spawnTmuxWorker: vi.fn(),
  ensureTmuxSession: vi.fn(() => 'multiclaude'),
  createTmuxWindow: vi.fn(() => '@1'),
}))

import { createDb, closeDb } from '../src/server/state/db.js'
import { createTask, updateTask, getTask } from '../src/server/state/tasks.js'
import { handleReportDone } from '../src/server/tools/worker.js'
import { handleGetSystemStatus } from '../src/server/tools/orchestrator.js'
import { MergeConflictError } from '../src/git/merge.js'
import type Database from 'better-sqlite3'

function setupTaskWithWorktree(db: Database.Database, id = 't1', runId?: string) {
  createTask(db, { id, title: 'Test task', run_id: runId })
  updateTask(db, id, {
    status: 'in_progress',
    worktree_path: '/tmp/fake-worktree',
    branch: 'feature/test',
    head_sha: null, // skip empty-branch check
    repo_path: '/fake/repo',
  })
}

describe('conflicted_files and conflict_branch round-trip', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('stores and retrieves conflicted_files as a string array', () => {
    createTask(db, { id: 't1', title: 'Test' })
    updateTask(db, 't1', { conflicted_files: ['src/index.ts', 'src/utils.ts'] })
    const task = getTask(db, 't1')
    expect(task?.conflicted_files).toEqual(['src/index.ts', 'src/utils.ts'])
  })

  it('stores and retrieves conflict_branch as a string', () => {
    createTask(db, { id: 't1', title: 'Test' })
    updateTask(db, 't1', { conflict_branch: 'mc/run-abc123' })
    const task = getTask(db, 't1')
    expect(task?.conflict_branch).toBe('mc/run-abc123')
  })

  it('returns null for conflicted_files when not set', () => {
    createTask(db, { id: 't1', title: 'Test' })
    const task = getTask(db, 't1')
    expect(task?.conflicted_files).toBeNull()
  })

  it('returns null for conflict_branch when not set', () => {
    createTask(db, { id: 't1', title: 'Test' })
    const task = getTask(db, 't1')
    expect(task?.conflict_branch).toBeNull()
  })

  it('clears conflicted_files when set to null', () => {
    createTask(db, { id: 't1', title: 'Test' })
    updateTask(db, 't1', { conflicted_files: ['src/foo.ts'] })
    updateTask(db, 't1', { conflicted_files: null })
    const task = getTask(db, 't1')
    expect(task?.conflicted_files).toBeNull()
  })

  it('returns empty array when conflicted_files contains malformed JSON', () => {
    createTask(db, { id: 't1', title: 'Test' })
    db.prepare("UPDATE tasks SET conflicted_files = 'not-valid-json' WHERE id = 't1'").run()
    const task = getTask(db, 't1')
    expect(task?.conflicted_files).toEqual([])
  })

  it('round-trips an empty array for conflicted_files', () => {
    createTask(db, { id: 't1', title: 'Test' })
    updateTask(db, 't1', { conflicted_files: [] })
    const task = getTask(db, 't1')
    expect(task?.conflicted_files).toEqual([])
  })
})

describe('handleReportDone — MergeConflictError path', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    mockEnsureIntegrationBranch.mockReset().mockResolvedValue(undefined)
    mockMergeWorktreeBranch.mockReset()
    mockIsMergedInto.mockReset().mockResolvedValue(false)
    mockRemoveWorktree.mockReset().mockResolvedValue(undefined)
    mockKillTmuxWindow.mockReset()
  })

  afterEach(() => { closeDb(db) })

  function throwConflict(files: string[], integBranch = 'mc/integration') {
    mockMergeWorktreeBranch.mockRejectedValue(
      new MergeConflictError('feature/test', integBranch, files)
    )
  }

  it('sets status=failed on MergeConflictError', async () => {
    setupTaskWithWorktree(db)
    throwConflict(['src/api.ts'])
    await handleReportDone(db, 't1', 'done')
    expect(getTask(db, 't1')?.status).toBe('failed')
  })

  it('sets failure_reason=merge_conflict (underscore)', async () => {
    setupTaskWithWorktree(db)
    throwConflict(['src/api.ts'])
    await handleReportDone(db, 't1', 'done')
    expect(getTask(db, 't1')?.failure_reason).toBe('merge_conflict')
  })

  it('persists failure_detail from the error message', async () => {
    setupTaskWithWorktree(db)
    throwConflict(['src/api.ts'])
    await handleReportDone(db, 't1', 'done')
    const task = getTask(db, 't1')
    expect(task?.failure_detail).toContain('src/api.ts')
  })

  it('persists conflicted_files as a string array', async () => {
    setupTaskWithWorktree(db)
    throwConflict(['src/api.ts', 'src/models.ts'])
    await handleReportDone(db, 't1', 'done')
    expect(getTask(db, 't1')?.conflicted_files).toEqual(['src/api.ts', 'src/models.ts'])
  })

  it('persists conflict_branch to the integration branch', async () => {
    setupTaskWithWorktree(db)
    throwConflict(['src/api.ts'])
    await handleReportDone(db, 't1', 'done')
    expect(getTask(db, 't1')?.conflict_branch).toBe('mc/integration')
  })

  it('does NOT set merged_into_run=true on conflict', async () => {
    setupTaskWithWorktree(db)
    throwConflict(['src/api.ts'])
    await handleReportDone(db, 't1', 'done')
    expect(getTask(db, 't1')?.merged_into_run).toBeNull()
  })

  it('does NOT call removeWorktree (branch preserved for inspection)', async () => {
    setupTaskWithWorktree(db)
    throwConflict(['src/api.ts'])
    await handleReportDone(db, 't1', 'done')
    expect(mockRemoveWorktree).not.toHaveBeenCalled()
  })

  it('inserts an error log entry with the conflict details', async () => {
    setupTaskWithWorktree(db)
    throwConflict(['src/api.ts', 'src/lib.ts'])
    await handleReportDone(db, 't1', 'done')
    const log = db.prepare(
      "SELECT message FROM logs WHERE task_id = 't1' AND level = 'error'"
    ).get() as { message: string } | undefined
    expect(log).toBeDefined()
    expect(log?.message).toContain('src/api.ts')
    expect(log?.message).toContain('src/lib.ts')
  })

  it('conflict_branch is the run integration branch when run_id is set', async () => {
    db.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p1', 'proj', '/fake/repo')").run()
    db.prepare("INSERT INTO runs (id, project_id, title) VALUES ('run-xyz', 'p1', 'Test run')").run()
    setupTaskWithWorktree(db, 't1', 'run-xyz')
    throwConflict(['src/api.ts'], 'mc/run-run-xyz')
    await handleReportDone(db, 't1', 'done')
    expect(getTask(db, 't1')?.conflict_branch).toBe('mc/run-run-xyz')
  })
})

describe('conflict fields surfaced in system status', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('get_system_status includes conflicted_files on failed tasks', () => {
    createTask(db, { id: 't1', title: 'Test' })
    updateTask(db, 't1', {
      status: 'failed',
      failure_reason: 'merge_conflict',
      conflicted_files: ['src/index.ts'],
      conflict_branch: 'mc/integration',
    })
    const status = handleGetSystemStatus(db, true)
    const task = status.tasks.find(t => t.id === 't1')
    expect(task?.conflicted_files).toEqual(['src/index.ts'])
    expect(task?.conflict_branch).toBe('mc/integration')
  })

  it('get_system_status returns null for conflicted_files when not set', () => {
    createTask(db, { id: 't1', title: 'Test' })
    const status = handleGetSystemStatus(db, true)
    const task = status.tasks.find(t => t.id === 't1')
    expect(task?.conflicted_files).toBeNull()
    expect(task?.conflict_branch).toBeNull()
  })
})
