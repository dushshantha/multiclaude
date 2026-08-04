/**
 * Tests for conflict-resolution worker spawn logic and post-resolution verification.
 *
 * Covers:
 * - spawnConflictResolutionWorker: decision logic (when to spawn, guard conditions)
 * - handleReportDone: propagation to original task when conflict worker completes
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---- Hoisted mocks (must precede imports) ----------------------------------

const {
  mockCreateWorktree,
  mockRemoveWorktree,
  mockSimpleGitMerge,
  mockSimpleGitRaw,
  mockEnsureIntegrationBranch,
  mockMergeWorktreeBranch,
  mockIsMergedInto,
  mockKillTmuxWindow,
} = vi.hoisted(() => {
  const mockSimpleGitRaw = vi.fn<(args: string[]) => Promise<string>>().mockResolvedValue('')
  const mockSimpleGitMerge = vi.fn<(args: string[]) => Promise<void>>()
  return {
    mockCreateWorktree: vi.fn<() => Promise<{
      path: string; branch: string; taskId: string; gitDir: string
      headSha: string; reconcileActions: []; priorBranch?: string
    }>>(),
    mockRemoveWorktree: vi.fn<() => Promise<void>>(),
    mockSimpleGitRaw,
    mockSimpleGitMerge,
    mockEnsureIntegrationBranch: vi.fn<() => Promise<void>>(),
    mockMergeWorktreeBranch: vi.fn<() => Promise<{ push: { ok: true; remoteBranch: string } }>>(),
    mockIsMergedInto: vi.fn<() => Promise<boolean>>(),
    mockKillTmuxWindow: vi.fn(),
  }
})

vi.mock('../src/git/worktree.js', () => ({
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
  preflightReconcile: vi.fn().mockResolvedValue({ actions: [], branch: 'feature/test' }),
  isProtectedBranch: vi.fn((b: string) => /^(main|master)$|^mc\/run-/.test(b)),
  readWorktreeGitDir: vi.fn(() => '/fake/.git/worktrees/t1'),
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
  RUN_INTEGRATION_BRANCH: (runId: string) => `mc/run-${runId}`,
  isAutoResolvable: vi.fn(() => false),
}))

vi.mock('../src/git/ops.js', () => ({
  pushBranch: vi.fn().mockResolvedValue({ ok: true, remoteBranch: 'origin/mc/integration' }),
}))

vi.mock('simple-git', () => ({
  simpleGit: () => ({
    raw: mockSimpleGitRaw,
    merge: mockSimpleGitMerge,
    fetch: vi.fn().mockResolvedValue(undefined),
    branchLocal: vi.fn().mockResolvedValue({ all: [] }),
    revparse: vi.fn().mockResolvedValue('abc123'),
    status: vi.fn().mockResolvedValue({ isClean: () => true }),
  }),
}))

vi.mock('../src/spawner/tmux.js', () => ({
  killTmuxWindow: mockKillTmuxWindow,
  captureTmuxPane: vi.fn(() => ''),
  spawnTmuxWorker: vi.fn(),
  ensureTmuxSession: vi.fn(() => 'multiclaude'),
  createTmuxWindow: vi.fn(() => '@1'),
  reapStaleWindows: vi.fn(),
}))

// ---- Imports after mocks ---------------------------------------------------

import { createDb, closeDb } from '../src/server/state/db.js'
import { createTask, updateTask, getTask } from '../src/server/state/tasks.js'
import { spawnConflictResolutionWorker } from '../src/server/tools/orchestrator.js'
import { handleReportDone } from '../src/server/tools/worker.js'
import type Database from 'better-sqlite3'

// ---- Helpers ---------------------------------------------------------------

function makeConflictedTask(db: Database.Database, id = 't1', opts: {
  runId?: string; branch?: string; repoPath?: string; conflictedFiles?: string[]
} = {}) {
  createTask(db, { id, title: `Task ${id}`, run_id: opts.runId })
  updateTask(db, id, {
    status: 'failed',
    failure_reason: 'merge_conflict',
    branch: opts.branch ?? 'feature/task',
    repo_path: opts.repoPath ?? '/fake/repo',
    conflicted_files: opts.conflictedFiles ?? ['src/api.ts'],
    conflict_branch: opts.runId ? `mc/run-${opts.runId}` : 'mc/integration',
    worktree_path: '/tmp/mc-t1-abc',
    head_sha: null,
  })
}

function fakeWorktreeInfo(taskId: string) {
  return {
    path: `/tmp/mc-${taskId}-xyz`,
    branch: `mc/${taskId}`,
    taskId,
    gitDir: `/fake/.git/worktrees/${taskId}`,
    headSha: 'deadbeef',
    reconcileActions: [] as [],
  }
}

function resetMocks() {
  mockCreateWorktree.mockReset().mockResolvedValue(fakeWorktreeInfo('conflict-t1'))
  mockRemoveWorktree.mockReset().mockResolvedValue(undefined)
  mockSimpleGitMerge.mockReset().mockRejectedValue(new Error('merge conflict'))
  mockSimpleGitRaw.mockReset().mockResolvedValue('src/api.ts')
  mockEnsureIntegrationBranch.mockReset().mockResolvedValue(undefined)
  mockMergeWorktreeBranch.mockReset().mockResolvedValue({ push: { ok: true, remoteBranch: 'origin/mc/integration' } })
  mockIsMergedInto.mockReset().mockResolvedValue(false)
  mockKillTmuxWindow.mockReset()
}

// ---- Tests: spawn decision logic -------------------------------------------

describe('spawnConflictResolutionWorker — guard conditions', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:'); resetMocks() })
  afterEach(() => closeDb(db))

  it('returns error when task not found', async () => {
    const result = await spawnConflictResolutionWorker(db, 'nonexistent')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; detail: string }).detail).toMatch(/not found/)
  })

  it('returns error when task is not in merge_conflict state', async () => {
    createTask(db, { id: 't1', title: 'Task' })
    updateTask(db, 't1', { status: 'failed', failure_reason: 'some_other_error' })
    const result = await spawnConflictResolutionWorker(db, 't1')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; detail: string }).detail).toMatch(/not in merge_conflict/)
  })

  it('returns error when task has no branch', async () => {
    createTask(db, { id: 't1', title: 'Task' })
    updateTask(db, 't1', {
      status: 'failed',
      failure_reason: 'merge_conflict',
      repo_path: '/fake/repo',
      conflicted_files: ['src/api.ts'],
      // branch intentionally not set
    })
    const result = await spawnConflictResolutionWorker(db, 't1')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; detail: string }).detail).toMatch(/missing branch or repo_path/)
  })

  it('returns error when task has no repo_path', async () => {
    createTask(db, { id: 't1', title: 'Task' })
    updateTask(db, 't1', {
      status: 'failed',
      failure_reason: 'merge_conflict',
      branch: 'feature/task',
      conflicted_files: ['src/api.ts'],
      // repo_path intentionally not set
    })
    const result = await spawnConflictResolutionWorker(db, 't1')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; detail: string }).detail).toMatch(/missing branch or repo_path/)
  })

  it('returns error when task has empty conflicted_files', async () => {
    makeConflictedTask(db, 't1', { conflictedFiles: [] })
    const result = await spawnConflictResolutionWorker(db, 't1')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; detail: string }).detail).toMatch(/no conflicted_files/)
  })

  it('returns existing conflictTaskId when live worker exists (in_progress)', async () => {
    makeConflictedTask(db)
    createTask(db, { id: 'conflict-t1', title: 'Existing worker' })
    updateTask(db, 'conflict-t1', { status: 'in_progress' })
    const result = await spawnConflictResolutionWorker(db, 't1')
    expect(result.ok).toBe(true)
    expect((result as { ok: true; conflictTaskId: string }).conflictTaskId).toBe('conflict-t1')
    // No new worktree should be created
    expect(mockCreateWorktree).not.toHaveBeenCalled()
  })

  it('returns existing conflictTaskId when live worker exists (pending)', async () => {
    makeConflictedTask(db)
    createTask(db, { id: 'conflict-t1', title: 'Existing worker' })
    // status defaults to 'pending'
    const result = await spawnConflictResolutionWorker(db, 't1')
    expect(result.ok).toBe(true)
    expect((result as { ok: true; conflictTaskId: string }).conflictTaskId).toBe('conflict-t1')
  })

  it('returns error when conflict worker already completed', async () => {
    makeConflictedTask(db)
    createTask(db, { id: 'conflict-t1', title: 'Done worker' })
    updateTask(db, 'conflict-t1', { status: 'done' })
    const result = await spawnConflictResolutionWorker(db, 't1')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; detail: string }).detail).toMatch(/already completed/)
  })

  it('returns error when conflict worker exists but failed', async () => {
    makeConflictedTask(db)
    createTask(db, { id: 'conflict-t1', title: 'Failed worker' })
    updateTask(db, 'conflict-t1', { status: 'failed' })
    const result = await spawnConflictResolutionWorker(db, 't1')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; detail: string }).detail).toMatch(/recover or cancel/)
  })
})

describe('spawnConflictResolutionWorker — successful spawn', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:'); resetMocks() })
  afterEach(() => closeDb(db))

  it('returns ok with conflictTaskId', async () => {
    makeConflictedTask(db)
    const result = await spawnConflictResolutionWorker(db, 't1')
    expect(result.ok).toBe(true)
    expect((result as { ok: true; conflictTaskId: string }).conflictTaskId).toBe('conflict-t1')
  })

  it('creates the conflict worker task in the DB', async () => {
    makeConflictedTask(db)
    await spawnConflictResolutionWorker(db, 't1')
    const conflictTask = getTask(db, 'conflict-t1')
    expect(conflictTask).not.toBeNull()
    expect(conflictTask?.title).toContain('src/api.ts')
  })

  it('sets conflict_worker_for on the conflict task', async () => {
    makeConflictedTask(db)
    await spawnConflictResolutionWorker(db, 't1')
    const conflictTask = getTask(db, 'conflict-t1')
    expect(conflictTask?.conflict_worker_for).toBe('t1')
  })

  it('sets effort=max on the conflict task', async () => {
    makeConflictedTask(db)
    await spawnConflictResolutionWorker(db, 't1')
    const conflictTask = getTask(db, 'conflict-t1')
    expect(conflictTask?.effort).toBe('max')
  })

  it('inherits model from the original task', async () => {
    createTask(db, { id: 't1', title: 'Task', model: 'opus' })
    updateTask(db, 't1', {
      status: 'failed', failure_reason: 'merge_conflict',
      branch: 'feature/task', repo_path: '/fake/repo',
      conflicted_files: ['src/api.ts'],
    })
    await spawnConflictResolutionWorker(db, 't1')
    const conflictTask = getTask(db, 'conflict-t1')
    expect(conflictTask?.model).toBe('opus')
  })

  it('creates an agent in spawning status', async () => {
    makeConflictedTask(db)
    await spawnConflictResolutionWorker(db, 't1')
    const agent = db.prepare("SELECT * FROM agents WHERE task_id = 'conflict-t1'").get() as
      { id: string; status: string; cwd: string } | undefined
    expect(agent).toBeDefined()
    expect(agent?.status).toBe('spawning')
  })

  it('agent cwd points to the conflict worktree path', async () => {
    makeConflictedTask(db)
    await spawnConflictResolutionWorker(db, 't1')
    const agent = db.prepare("SELECT * FROM agents WHERE task_id = 'conflict-t1'").get() as
      { cwd: string } | undefined
    expect(agent?.cwd).toBe('/tmp/mc-conflict-t1-xyz')
  })

  it('sets worktree_path, branch, head_sha on conflict task', async () => {
    makeConflictedTask(db)
    await spawnConflictResolutionWorker(db, 't1')
    const conflictTask = getTask(db, 'conflict-t1')
    expect(conflictTask?.worktree_path).toBe('/tmp/mc-conflict-t1-xyz')
    expect(conflictTask?.branch).toBe('mc/conflict-t1')
    expect(conflictTask?.head_sha).toBe('deadbeef')
  })

  it('sets task status to in_progress after spawning agent', async () => {
    makeConflictedTask(db)
    await spawnConflictResolutionWorker(db, 't1')
    const conflictTask = getTask(db, 'conflict-t1')
    expect(conflictTask?.status).toBe('in_progress')
  })

  it('creates worktree based on integration branch', async () => {
    db.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p1', 'proj', '/fake/repo')").run()
    db.prepare("INSERT INTO runs (id, project_id, title) VALUES ('run-abc', 'p1', 'Test Run')").run()
    makeConflictedTask(db, 't1', { runId: 'run-abc' })
    await spawnConflictResolutionWorker(db, 't1')
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      '/fake/repo', 'conflict-t1', undefined, 'mc/run-run-abc'
    )
  })

  it('creates worktree based on mc/integration when no run_id', async () => {
    makeConflictedTask(db, 't1', { branch: 'feature/task' })
    await spawnConflictResolutionWorker(db, 't1')
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      '/fake/repo', 'conflict-t1', undefined, 'mc/integration'
    )
  })

  it('runs git merge in the conflict worktree to reproduce conflict state', async () => {
    makeConflictedTask(db)
    await spawnConflictResolutionWorker(db, 't1')
    expect(mockSimpleGitMerge).toHaveBeenCalledWith(
      expect.arrayContaining(['feature/task', '--no-ff'])
    )
  })

  it('updates original task failure_detail to note worker spawned', async () => {
    makeConflictedTask(db)
    await spawnConflictResolutionWorker(db, 't1')
    const original = getTask(db, 't1')
    expect(original?.failure_detail).toContain('conflict-t1')
  })

  it('logs worker spawn on original task', async () => {
    makeConflictedTask(db)
    await spawnConflictResolutionWorker(db, 't1')
    const log = db.prepare(
      "SELECT message FROM logs WHERE task_id = 't1' AND level = 'info'"
    ).get() as { message: string } | undefined
    expect(log?.message).toMatch(/conflict-t1/)
  })

  it('handles clean merge (no conflicts) gracefully — still spawns worker', async () => {
    // If the merge succeeds without conflicts, the commit is already made.
    // The worker will call report_done and the merge lands normally.
    mockSimpleGitMerge.mockResolvedValue(undefined)
    makeConflictedTask(db)
    const result = await spawnConflictResolutionWorker(db, 't1')
    expect(result.ok).toBe(true)
    const conflictTask = getTask(db, 'conflict-t1')
    expect(conflictTask?.status).toBe('in_progress')
  })

  it('returns error when worktree creation fails', async () => {
    mockCreateWorktree.mockRejectedValue(new Error('disk full'))
    makeConflictedTask(db)
    const result = await spawnConflictResolutionWorker(db, 't1')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; detail: string }).detail).toMatch(/disk full/)
  })

  it('marks conflict task failed and returns error when worktree fails', async () => {
    mockCreateWorktree.mockRejectedValue(new Error('disk full'))
    makeConflictedTask(db)
    await spawnConflictResolutionWorker(db, 't1')
    const conflictTask = getTask(db, 'conflict-t1')
    expect(conflictTask?.status).toBe('failed')
    expect(conflictTask?.failure_reason).toBe('worktree_create_failed')
  })

  it('returns error when merge fails unexpectedly (no conflict markers)', async () => {
    mockSimpleGitMerge.mockRejectedValue(new Error('fatal: something unexpected'))
    mockSimpleGitRaw.mockResolvedValue('') // no conflicted files
    makeConflictedTask(db)
    const result = await spawnConflictResolutionWorker(db, 't1')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; detail: string }).detail).toMatch(/reproduce merge conflict/)
  })

  it('cleans up worktree when merge setup fails unexpectedly', async () => {
    mockSimpleGitMerge.mockRejectedValue(new Error('fatal: something unexpected'))
    mockSimpleGitRaw.mockResolvedValue('')
    makeConflictedTask(db)
    await spawnConflictResolutionWorker(db, 't1')
    expect(mockRemoveWorktree).toHaveBeenCalled()
  })
})

// ---- Tests: post-resolution verification -----------------------------------

describe('handleReportDone — conflict worker propagates to original task', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    resetMocks()
    mockMergeWorktreeBranch.mockResolvedValue({ push: { ok: true, remoteBranch: 'origin/mc/integration' } })
    mockIsMergedInto.mockResolvedValue(true)
  })
  afterEach(() => closeDb(db))

  function setupOriginalTask(id = 't1') {
    createTask(db, { id, title: 'Original task' })
    updateTask(db, id, {
      status: 'failed',
      failure_reason: 'merge_conflict',
      branch: 'feature/task',
      repo_path: '/fake/repo',
      conflicted_files: ['src/api.ts'],
      conflict_branch: 'mc/integration',
    })
  }

  function setupConflictTask(originalId = 't1', conflictId = 'conflict-t1') {
    createTask(db, { id: conflictId, title: 'Resolve conflict', conflict_worker_for: originalId })
    updateTask(db, conflictId, {
      status: 'in_progress',
      branch: 'mc/conflict-t1',
      worktree_path: '/tmp/mc-conflict-t1-xyz',
      head_sha: null, // skip empty branch check
      repo_path: '/fake/repo',
      agent_id: `w-${conflictId}`,
    })
    db.prepare("INSERT INTO agents (id, task_id, status) VALUES (?, ?, 'running')").run(
      `w-${conflictId}`, conflictId
    )
  }

  it('marks original task as done when merge verified', async () => {
    setupOriginalTask()
    setupConflictTask()
    await handleReportDone(db, 'conflict-t1', 'Resolved conflicts in src/api.ts')
    const original = getTask(db, 't1')
    expect(original?.status).toBe('done')
  })

  it('sets merged_into_run=true on original task when verified', async () => {
    setupOriginalTask()
    setupConflictTask()
    await handleReportDone(db, 'conflict-t1', 'Resolved')
    const original = getTask(db, 't1')
    expect(original?.merged_into_run).toBe(true)
  })

  it('clears conflicted_files on original task when verified', async () => {
    setupOriginalTask()
    setupConflictTask()
    await handleReportDone(db, 'conflict-t1', 'Resolved')
    const original = getTask(db, 't1')
    expect(original?.conflicted_files).toBeNull()
  })

  it('clears conflict_branch on original task when verified', async () => {
    setupOriginalTask()
    setupConflictTask()
    await handleReportDone(db, 'conflict-t1', 'Resolved')
    const original = getTask(db, 't1')
    expect(original?.conflict_branch).toBeNull()
  })

  it('clears failure_reason on original task when verified', async () => {
    setupOriginalTask()
    setupConflictTask()
    await handleReportDone(db, 'conflict-t1', 'Resolved')
    const original = getTask(db, 't1')
    expect(original?.failure_reason).toBeNull()
  })

  it('logs DONE on original task when verified', async () => {
    setupOriginalTask()
    setupConflictTask()
    await handleReportDone(db, 'conflict-t1', 'Resolved')
    const log = db.prepare(
      "SELECT message FROM logs WHERE task_id = 't1' AND level = 'info' AND message LIKE 'DONE:%'"
    ).get() as { message: string } | undefined
    expect(log).toBeDefined()
    expect(log?.message).toContain('conflict-t1')
  })

  it('calls isMergedInto with the original task branch', async () => {
    setupOriginalTask()
    setupConflictTask()
    await handleReportDone(db, 'conflict-t1', 'Resolved')
    expect(mockIsMergedInto).toHaveBeenCalledWith(
      '/fake/repo', 'feature/task', 'mc/integration'
    )
  })

  it('leaves original task unchanged when isMergedInto returns false', async () => {
    mockIsMergedInto.mockResolvedValue(false)
    setupOriginalTask()
    setupConflictTask()
    await handleReportDone(db, 'conflict-t1', 'Resolved')
    const original = getTask(db, 't1')
    expect(original?.status).toBe('failed')
    expect(original?.failure_reason).toBe('merge_conflict')
  })

  it('logs a warning when isMergedInto returns false', async () => {
    mockIsMergedInto.mockResolvedValue(false)
    setupOriginalTask()
    setupConflictTask()
    await handleReportDone(db, 'conflict-t1', 'Resolved')
    const log = db.prepare(
      "SELECT message FROM logs WHERE task_id = 't1' AND level = 'warn'"
    ).get() as { message: string } | undefined
    expect(log).toBeDefined()
    expect(log?.message).toMatch(/not yet in/)
  })

  it('conflict task itself is marked done', async () => {
    setupOriginalTask()
    setupConflictTask()
    await handleReportDone(db, 'conflict-t1', 'Resolved')
    const conflictTask = getTask(db, 'conflict-t1')
    expect(conflictTask?.status).toBe('done')
  })

  it('does not propagate when merge failed (mergedIntoRun=false)', async () => {
    mockMergeWorktreeBranch.mockRejectedValue(new Error('merge failed'))
    mockIsMergedInto.mockResolvedValue(false)
    setupOriginalTask()
    setupConflictTask()
    await handleReportDone(db, 'conflict-t1', 'Resolved')
    // Original task should still be in failed state
    const original = getTask(db, 't1')
    expect(original?.status).toBe('failed')
    // isMergedInto for the original branch should NOT have been called for propagation
    // (it may be called for the conflict task's own merge verification, but not for the original)
    const doneLogs = db.prepare(
      "SELECT message FROM logs WHERE task_id = 't1' AND level = 'info' AND message LIKE 'DONE:%'"
    ).all() as { message: string }[]
    expect(doneLogs).toHaveLength(0)
  })

  it('does not propagate when conflict_worker_for is null', async () => {
    // Normal task (not a conflict worker) with a worktree_path
    createTask(db, { id: 'normal-task', title: 'Normal task' })
    updateTask(db, 'normal-task', {
      status: 'in_progress',
      branch: 'feature/normal',
      worktree_path: '/tmp/mc-normal-xyz',
      head_sha: null,
      repo_path: '/fake/repo',
      agent_id: 'w-normal-task',
    })
    db.prepare("INSERT INTO agents (id, task_id, status) VALUES ('w-normal-task', 'normal-task', 'running')").run()

    await handleReportDone(db, 'normal-task', 'Done normally')
    // isMergedInto should NOT be called for propagation (no conflict_worker_for)
    // It may be called for the task's own empty-branch check but not for original task
    expect(mockIsMergedInto).not.toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String)
    )
  })
})

// ---- Tests: failure path ---------------------------------------------------

describe('conflict worker failure path', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:'); resetMocks() })
  afterEach(() => closeDb(db))

  it('original task retains merge_conflict failure_reason when conflict worker never runs', async () => {
    makeConflictedTask(db)
    // Don't spawn — original task just stays failed
    const original = getTask(db, 't1')
    expect(original?.failure_reason).toBe('merge_conflict')
    expect(original?.conflicted_files).toEqual(['src/api.ts'])
  })

  it('conflict task description contains original task, branch, integration branch, and files', async () => {
    makeConflictedTask(db, 't1', { branch: 'feature/my-work', conflictedFiles: ['src/a.ts', 'src/b.ts'] })
    await spawnConflictResolutionWorker(db, 't1')
    const conflictTask = getTask(db, 'conflict-t1')
    expect(conflictTask?.description).toContain('feature/my-work')
    expect(conflictTask?.description).toContain('src/a.ts')
    expect(conflictTask?.description).toContain('src/b.ts')
    expect(conflictTask?.description).toContain('mc/integration')
  })

  it('conflict task title lists the conflicted files for orchestrator reporting', async () => {
    makeConflictedTask(db, 't1', { conflictedFiles: ['src/auth.ts', 'src/models.ts'] })
    await spawnConflictResolutionWorker(db, 't1')
    const conflictTask = getTask(db, 'conflict-t1')
    expect(conflictTask?.title).toContain('src/auth.ts')
    expect(conflictTask?.title).toContain('src/models.ts')
  })

  it('original task failure_detail notes the conflict worker task ID', async () => {
    makeConflictedTask(db)
    await spawnConflictResolutionWorker(db, 't1')
    const original = getTask(db, 't1')
    expect(original?.failure_detail).toContain('conflict-t1')
  })

  it('does not spawn if original task was not in merge_conflict state', async () => {
    createTask(db, { id: 't1', title: 'Task' })
    updateTask(db, 't1', { status: 'done' })
    const result = await spawnConflictResolutionWorker(db, 't1')
    expect(result.ok).toBe(false)
    expect(mockCreateWorktree).not.toHaveBeenCalled()
  })
})
