import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'

// ---- Mocks ----------------------------------------------------------------

const {
  mockPushBranch,
  mockGetBranchSyncState,
  mockHasRemote,
  mockGetRemoteUrl,
  mockParseGitHubRemote,
  mockCreatePullRequest,
  mockEnsureIntegrationBranch,
  mockMergeWorktreeBranch,
  mockSimpleGitRaw,
  mockSimpleGitFetch,
  mockSimpleGitMerge,
} = vi.hoisted(() => {
  const mockSimpleGitRaw = vi.fn<(args: string[]) => Promise<string>>().mockResolvedValue('')
  const mockSimpleGitFetch = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const mockSimpleGitMerge = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  return {
    mockPushBranch: vi.fn<() => Promise<{ ok: true; remoteBranch: string }>>(),
    mockGetBranchSyncState: vi.fn<() => Promise<{ exists: boolean; existsOnRemote: boolean; ahead: number; behind: number }>>(),
    mockHasRemote: vi.fn<() => Promise<boolean>>(),
    mockGetRemoteUrl: vi.fn<() => Promise<string | null>>(),
    mockParseGitHubRemote: vi.fn<(url: string) => { owner: string; repo: string } | null>(),
    mockCreatePullRequest: vi.fn<() => Promise<any>>(),
    mockEnsureIntegrationBranch: vi.fn<() => Promise<void>>(),
    mockMergeWorktreeBranch: vi.fn<() => Promise<{ push: { ok: true; remoteBranch: string } }>>(),
    mockSimpleGitRaw,
    mockSimpleGitFetch,
    mockSimpleGitMerge,
  }
})

vi.mock('simple-git', () => ({
  simpleGit: () => ({
    raw: mockSimpleGitRaw,
    fetch: mockSimpleGitFetch,
    merge: mockSimpleGitMerge,
    env: vi.fn().mockReturnThis(),
    branchLocal: vi.fn().mockResolvedValue({ all: [] }),
    branch: vi.fn().mockResolvedValue({ all: [] }),
  }),
}))

vi.mock('../src/git/ops.js', () => ({
  pushBranch: mockPushBranch,
  getBranchSyncState: mockGetBranchSyncState,
  hasRemote: mockHasRemote,
  getRemoteUrl: mockGetRemoteUrl,
  parseGitHubRemote: mockParseGitHubRemote,
  classifyPushFailure: vi.fn(() => 'push_failed'),
}))

vi.mock('../src/git/pr.js', () => ({
  createPullRequest: mockCreatePullRequest,
  parseGitHubRemote: vi.fn(),
}))

vi.mock('../src/git/merge.js', () => {
  const { basename } = require('path')
  const AUTO_RESOLVABLE_FILES = new Set([
    'package-lock.json', 'package.json', 'yarn.lock', 'pnpm-lock.yaml',
    'bun.lockb', 'shrinkwrap.json', 'npm-shrinkwrap.json', 'Gemfile.lock',
    'Pipfile.lock', 'poetry.lock', 'composer.lock', 'Cargo.lock', 'go.sum', 'go.mod',
  ])
  return {
    ensureIntegrationBranch: mockEnsureIntegrationBranch,
    mergeWorktreeBranch: mockMergeWorktreeBranch,
    RUN_INTEGRATION_BRANCH: (runId: string) => `mc/run-${runId}`,
    isAutoResolvable: (filePath: string) => {
      const name = basename(filePath)
      return AUTO_RESOLVABLE_FILES.has(name) || name.endsWith('.lock')
    },
    isMergedInto: vi.fn().mockResolvedValue(false),
    MergeConflictError: class MergeConflictError extends Error {
      taskBranch: string; integBranch: string; conflictedFiles: string[]
      constructor(taskBranch: string, integBranch: string, conflictedFiles: string[]) {
        super(`Merge conflict: ${taskBranch} cannot be merged into ${integBranch} — conflicted files: ${conflictedFiles.join(', ')}`)
        this.name = 'MergeConflictError'
        this.taskBranch = taskBranch; this.integBranch = integBranch; this.conflictedFiles = conflictedFiles
      }
    },
  }
})

vi.mock('../src/spawner/tmux.js', () => ({
  killTmuxWindow: vi.fn(),
  reapStaleWindows: vi.fn(),
  ensureTmuxSession: vi.fn(() => 'multiclaude'),
  captureTmuxPane: vi.fn(() => ''),
  spawnTmuxWorker: vi.fn(),
  createTmuxWindow: vi.fn(() => '@1'),
}))

// ---- Imports after mocks --------------------------------------------------

import { createDb, closeDb } from '../src/server/state/db.js'
import { createTask, updateTask, getTask } from '../src/server/state/tasks.js'
import { getRun } from '../src/server/state/runs.js'
import {
  handleGitStatus,
  handlePushRunBranch,
  handleCreatePr,
  handleResolveMergeConflict,
  handleCompleteTask,
} from '../src/server/tools/orchestrator.js'
import { MergeConflictError } from '../src/git/merge.js'

// ---- Helpers --------------------------------------------------------------

function setupProject(db: Database.Database, cwd = '/fake/repo') {
  db.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p1', 'proj', ?)").run(cwd)
}

function setupRun(db: Database.Database, runId = 'run-1') {
  setupProject(db)
  db.prepare("INSERT INTO runs (id, project_id, title) VALUES (?, 'p1', 'Test Run')").run(runId)
  return runId
}

function setupDoneTask(db: Database.Database, id: string, runId: string, opts: { merged?: boolean; ticket?: string; branch?: string } = {}) {
  createTask(db, { id, title: `Task ${id}`, run_id: runId, ticket: opts.ticket })
  updateTask(db, id, {
    status: 'done',
    branch: opts.branch ?? `mc/${id}`,
    merged_into_run: opts.merged ?? true,
    repo_path: '/fake/repo',
  })
  db.prepare(
    "INSERT INTO logs (task_id, level, message) VALUES (?, 'info', ?)"
  ).run(id, `DONE: Implemented ${id}`)
}

function resetMocks() {
  mockPushBranch.mockReset().mockResolvedValue({ ok: true, remoteBranch: 'origin/mc/run-run-1' })
  mockGetBranchSyncState.mockReset().mockResolvedValue({ exists: true, existsOnRemote: true, ahead: 1, behind: 0 })
  mockHasRemote.mockReset().mockResolvedValue(true)
  mockGetRemoteUrl.mockReset().mockResolvedValue('https://github.com/test/repo.git')
  mockParseGitHubRemote.mockReset().mockReturnValue({ owner: 'test', repo: 'repo' })
  mockCreatePullRequest.mockReset().mockResolvedValue({ ok: true, url: 'https://github.com/test/repo/pull/42', number: 42, alreadyExisted: false })
  mockEnsureIntegrationBranch.mockReset().mockResolvedValue(undefined)
  mockMergeWorktreeBranch.mockReset().mockResolvedValue({ push: { ok: true, remoteBranch: 'origin/mc/run-run-1' } })
  mockSimpleGitRaw.mockReset().mockResolvedValue('')
  mockSimpleGitFetch.mockReset().mockResolvedValue(undefined)
  mockSimpleGitMerge.mockReset().mockResolvedValue(undefined)
}

// ---- Tests ----------------------------------------------------------------

describe('handleGitStatus', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    resetMocks()
  })
  afterEach(() => closeDb(db))

  it('returns error for unknown run', async () => {
    const result = await handleGitStatus(db, 'nonexistent')
    expect('error' in result).toBe(true)
  })

  it('returns full status for a valid run', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId)

    const result = await handleGitStatus(db, runId)
    expect('error' in result).toBe(false)

    const status = result as Exclude<typeof result, { error: string }>
    expect(status.integrationBranch).toBe('mc/run-run-1')
    expect(status.branchExists).toBe(true)
    expect(status.existsOnRemote).toBe(true)
    expect(status.hasRemote).toBe(true)
    expect(status.github).toEqual({ owner: 'test', repo: 'repo' })
    expect(status.tasks).toHaveLength(1)
    expect(status.tasks[0].id).toBe('t1')
  })

  it('lists blockers when tasks are not done', async () => {
    const runId = setupRun(db)
    createTask(db, { id: 't1', title: 'Pending', run_id: runId })

    const result = await handleGitStatus(db, runId) as Exclude<typeof result, { error: string }>
    expect(result.blockers.some(b => b.includes('not done'))).toBe(true)
  })

  it('lists blockers when done tasks are not merged', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId, { merged: false })

    const result = await handleGitStatus(db, runId) as Exclude<typeof result, { error: string }>
    expect(result.blockers.some(b => b.includes('not merged'))).toBe(true)
  })

  it('lists blockers when integration branch does not exist', async () => {
    mockGetBranchSyncState.mockResolvedValue({ exists: false, existsOnRemote: false, ahead: 0, behind: 0 })
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId)

    const result = await handleGitStatus(db, runId) as Exclude<typeof result, { error: string }>
    expect(result.blockers.some(b => b.includes('does not exist'))).toBe(true)
  })

  it('lists blockers when no remote configured', async () => {
    mockHasRemote.mockResolvedValue(false)
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId)

    const result = await handleGitStatus(db, runId) as Exclude<typeof result, { error: string }>
    expect(result.blockers.some(b => b.includes('No origin remote'))).toBe(true)
  })

  it('returns no blockers when everything is ready', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId)
    setupDoneTask(db, 't2', runId)

    const result = await handleGitStatus(db, runId) as Exclude<typeof result, { error: string }>
    expect(result.blockers).toHaveLength(0)
  })
})

describe('handlePushRunBranch', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    resetMocks()
  })
  afterEach(() => closeDb(db))

  it('returns error for unknown run', async () => {
    const result = await handlePushRunBranch(db, 'nonexistent')
    expect(result.ok).toBe(false)
  })

  it('pushes the integration branch', async () => {
    const runId = setupRun(db)
    const result = await handlePushRunBranch(db, runId)
    expect(result.ok).toBe(true)
    expect(mockPushBranch).toHaveBeenCalledWith('/fake/repo', 'mc/run-run-1')
  })

  it('retries on non_fast_forward with fetch+merge', async () => {
    mockPushBranch
      .mockResolvedValueOnce({ ok: false, reason: 'non_fast_forward', detail: 'rejected' })
      .mockResolvedValueOnce({ ok: true, remoteBranch: 'origin/mc/run-run-1' })

    const runId = setupRun(db)
    const result = await handlePushRunBranch(db, runId)
    expect(result.ok).toBe(true)
    expect(mockPushBranch).toHaveBeenCalledTimes(2)
  })
})

describe('handleCreatePr', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    resetMocks()
  })
  afterEach(() => closeDb(db))

  it('refuses when a task is not done', async () => {
    const runId = setupRun(db)
    createTask(db, { id: 't1', title: 'Pending', run_id: runId })

    const result = await handleCreatePr(db, runId)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('tasks_not_done')
    }
  })

  it('refuses when a done task is not merged into run', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId, { merged: false })

    const result = await handleCreatePr(db, runId)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('tasks_not_merged')
    }
  })

  it('creates PR with correct arguments when all tasks done and merged', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId, { ticket: '#42' })
    setupDoneTask(db, 't2', runId, { ticket: '#45' })

    const result = await handleCreatePr(db, runId)
    expect(result.ok).toBe(true)
    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1)

    const callArgs = mockCreatePullRequest.mock.calls[0][0]
    expect(callArgs.head).toBe('mc/run-run-1')
    expect(callArgs.title).toBe('Test Run')
  })

  it('generates closing keywords with one "closes" per issue — Closes #42, closes #45', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId, { ticket: '#42' })
    setupDoneTask(db, 't2', runId, { ticket: '#45' })
    setupDoneTask(db, 't3', runId, { ticket: '#42' })

    await handleCreatePr(db, runId)

    const callArgs = mockCreatePullRequest.mock.calls[0][0]
    const body: string = callArgs.body
    expect(body).toContain('closes #42, closes #45')
    // Must NOT have the broken "Closes #42, #45" form
    expect(body).not.toMatch(/closes #42, #45(?!\d)/i)
  })

  it('generates correct closing keyword for a single ticket', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId, { ticket: '#99' })

    await handleCreatePr(db, runId)

    const body: string = mockCreatePullRequest.mock.calls[0][0].body
    expect(body).toContain('closes #99')
  })

  it('omits closing keywords when no tasks have tickets', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId)

    await handleCreatePr(db, runId)

    const body: string = mockCreatePullRequest.mock.calls[0][0].body
    expect(body).not.toMatch(/closes/i)
  })

  it('includes task summaries from DONE log entries in PR body', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId)

    await handleCreatePr(db, runId)

    const body: string = mockCreatePullRequest.mock.calls[0][0].body
    expect(body).toContain('**t1**')
    expect(body).toContain('Implemented t1')
  })

  it('persists pr_url on the run row', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId)

    await handleCreatePr(db, runId)

    const run = getRun(db, runId)
    expect(run?.pr_url).toBe('https://github.com/test/repo/pull/42')
  })

  it('returns already-existed when pr_url is already set (idempotent)', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId)
    db.prepare("UPDATE runs SET pr_url = 'https://github.com/test/repo/pull/99' WHERE id = ?").run(runId)

    const result = await handleCreatePr(db, runId)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.alreadyExisted).toBe(true)
      expect(result.url).toBe('https://github.com/test/repo/pull/99')
    }
    expect(mockCreatePullRequest).not.toHaveBeenCalled()
  })

  it('pushes the branch before creating the PR', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId)

    await handleCreatePr(db, runId)
    expect(mockPushBranch).toHaveBeenCalled()
    // PR creation must come after push
    const pushOrder = mockPushBranch.mock.invocationCallOrder[0]
    const prOrder = mockCreatePullRequest.mock.invocationCallOrder[0]
    expect(pushOrder).toBeLessThan(prOrder)
  })

  it('refuses when push fails', async () => {
    mockPushBranch.mockResolvedValue({ ok: false, reason: 'no_remote', detail: 'No origin' })
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId)

    const result = await handleCreatePr(db, runId)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('push_failed')
    }
    expect(mockCreatePullRequest).not.toHaveBeenCalled()
  })

  it('uses custom title and base when provided', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId)

    await handleCreatePr(db, runId, { title: 'Custom Title', base: 'develop' })

    const callArgs = mockCreatePullRequest.mock.calls[0][0]
    expect(callArgs.title).toBe('Custom Title')
    expect(callArgs.base).toBe('develop')
  })

  it('uses custom body when provided', async () => {
    const runId = setupRun(db)
    setupDoneTask(db, 't1', runId)

    await handleCreatePr(db, runId, { body: 'Custom body content' })

    const callArgs = mockCreatePullRequest.mock.calls[0][0]
    expect(callArgs.body).toBe('Custom body content')
  })
})

describe('handleResolveMergeConflict', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    resetMocks()
  })
  afterEach(() => closeDb(db))

  it('returns error for unknown task', async () => {
    const result = await handleResolveMergeConflict(db, 'nonexistent')
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('not found')
  })

  it('returns error when task is not in merge_conflict state', async () => {
    createTask(db, { id: 't1', title: 'Test' })
    updateTask(db, 't1', { status: 'failed', failure_reason: 'other' })

    const result = await handleResolveMergeConflict(db, 't1')
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('not in merge_conflict')
  })

  it('re-drives merge and clears conflict state on success', async () => {
    setupProject(db)
    db.prepare("INSERT INTO runs (id, project_id, title) VALUES ('run-1', 'p1', 'Run')").run()
    createTask(db, { id: 't1', title: 'Test', run_id: 'run-1' })
    updateTask(db, 't1', {
      status: 'failed',
      failure_reason: 'merge_conflict',
      branch: 'mc/t1',
      repo_path: '/fake/repo',
      conflicted_files: ['src/api.ts'],
      conflict_branch: 'mc/run-run-1',
    })

    const result = await handleResolveMergeConflict(db, 't1')
    expect(result.ok).toBe(true)

    const task = getTask(db, 't1')
    expect(task?.status).toBe('done')
    expect(task?.merged_into_run).toBe(true)
    expect(task?.conflicted_files).toBeNull()
    expect(task?.conflict_branch).toBeNull()
  })

  it('returns needsWorker when merge still conflicts and no strategy given', async () => {
    mockMergeWorktreeBranch.mockRejectedValue(
      new Error('Merge conflict: mc/t1 cannot be merged into mc/run-run-1 — conflicted files: src/api.ts, src/models.ts')
    )

    setupProject(db)
    db.prepare("INSERT INTO runs (id, project_id, title) VALUES ('run-1', 'p1', 'Run')").run()
    createTask(db, { id: 't1', title: 'Test', run_id: 'run-1' })
    updateTask(db, 't1', {
      status: 'failed',
      failure_reason: 'merge_conflict',
      branch: 'mc/t1',
      repo_path: '/fake/repo',
      conflicted_files: ['src/api.ts', 'src/models.ts'],
      conflict_branch: 'mc/run-run-1',
    })

    const result = await handleResolveMergeConflict(db, 't1')
    expect(result.ok).toBe(false)
    expect(result.needsWorker).toBe(true)
    expect(result.conflictedFiles).toContain('src/api.ts')
    expect(result.conflictedFiles).toContain('src/models.ts')
  })

  it('does not force-resolve semantic conflicts without an explicit strategy', async () => {
    mockMergeWorktreeBranch.mockRejectedValue(
      new Error('Merge conflict: mc/t1 cannot be merged into mc/run-run-1 — conflicted files: src/important.ts')
    )

    setupProject(db)
    db.prepare("INSERT INTO runs (id, project_id, title) VALUES ('run-1', 'p1', 'Run')").run()
    createTask(db, { id: 't1', title: 'Test', run_id: 'run-1' })
    updateTask(db, 't1', {
      status: 'failed',
      failure_reason: 'merge_conflict',
      branch: 'mc/t1',
      repo_path: '/fake/repo',
      conflicted_files: ['src/important.ts'],
      conflict_branch: 'mc/run-run-1',
    })

    const result = await handleResolveMergeConflict(db, 't1')
    expect(result.ok).toBe(false)
    expect(result.needsWorker).toBe(true)
    // The task status should NOT have been changed to done
    expect(getTask(db, 't1')?.status).toBe('failed')
  })

  it('re-drives merge for a done-but-unmerged task (escape hatch)', async () => {
    setupProject(db)
    db.prepare("INSERT INTO runs (id, project_id, title) VALUES ('run-1', 'p1', 'Run')").run()
    createTask(db, { id: 't1', title: 'Test', run_id: 'run-1' })
    updateTask(db, 't1', {
      status: 'done',
      merged_into_run: false,
      branch: 'mc/t1',
      repo_path: '/fake/repo',
    })

    const result = await handleResolveMergeConflict(db, 't1')
    expect(result.ok).toBe(true)

    const task = getTask(db, 't1')
    expect(task?.status).toBe('done')
    expect(task?.merged_into_run).toBe(true)
    expect(mockEnsureIntegrationBranch).toHaveBeenCalledWith('/fake/repo', 'run-1')
    expect(mockMergeWorktreeBranch).toHaveBeenCalled()
  })

  it('returns error for done task with null merged_into_run that is not actually done+unmerged eligible — fully merged task', async () => {
    createTask(db, { id: 't1', title: 'Test' })
    updateTask(db, 't1', {
      status: 'done',
      merged_into_run: true,
    })

    const result = await handleResolveMergeConflict(db, 't1')
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('not in merge_conflict')
  })
})

describe('handleCompleteTask', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    resetMocks()
  })
  afterEach(() => closeDb(db))

  it('marks the task done and attempts the merge when branch+worktree+repo_path present', async () => {
    setupProject(db)
    db.prepare("INSERT INTO runs (id, project_id, title) VALUES ('run-1', 'p1', 'Run')").run()
    createTask(db, { id: 't1', title: 'Test', run_id: 'run-1' })
    updateTask(db, 't1', {
      status: 'in_progress',
      branch: 'mc/t1',
      worktree_path: '/tmp/mc-t1',
      repo_path: '/fake/repo',
    })

    const result = await handleCompleteTask(db, 't1', 'worker finished')

    expect(result.ok).toBe(true)
    expect(result.merged).toBe(true)
    expect(result.reason).toBeUndefined()

    const task = getTask(db, 't1')
    expect(task?.status).toBe('done')
    expect(task?.merged_into_run).toBe(true)

    expect(mockEnsureIntegrationBranch).toHaveBeenCalledWith('/fake/repo', 'run-1')
    expect(mockMergeWorktreeBranch).toHaveBeenCalledWith('/fake/repo', 'mc/t1', 'run-1', '/tmp/mc-t1')
  })

  it('skips merge and does not throw when task has no branch', async () => {
    createTask(db, { id: 't1', title: 'Test' })
    updateTask(db, 't1', { status: 'in_progress' })

    const result = await handleCompleteTask(db, 't1', 'worker finished without worktree')

    expect(result.ok).toBe(true)
    expect(result.merged).toBe(false)
    expect(result.reason).toContain('no_branch')

    const task = getTask(db, 't1')
    expect(task?.status).toBe('done')
    expect(task?.merged_into_run).toBeNull()

    expect(mockMergeWorktreeBranch).not.toHaveBeenCalled()
  })

  it('skips merge when task has no worktree_path', async () => {
    createTask(db, { id: 't1', title: 'Test' })
    updateTask(db, 't1', {
      status: 'in_progress',
      branch: 'mc/t1',
      repo_path: '/fake/repo',
    })

    const result = await handleCompleteTask(db, 't1', 'summary')

    expect(result.ok).toBe(true)
    expect(result.merged).toBe(false)
    expect(result.reason).toContain('no_worktree_path')

    expect(mockMergeWorktreeBranch).not.toHaveBeenCalled()
  })

  it('sets task to failed/merge_conflict and returns ok:false when merge conflicts', async () => {
    mockMergeWorktreeBranch.mockRejectedValue(
      new MergeConflictError('mc/t1', 'mc/run-run-1', ['src/api.ts'])
    )

    setupProject(db)
    db.prepare("INSERT INTO runs (id, project_id, title) VALUES ('run-1', 'p1', 'Run')").run()
    createTask(db, { id: 't1', title: 'Test', run_id: 'run-1' })
    updateTask(db, 't1', {
      status: 'in_progress',
      branch: 'mc/t1',
      worktree_path: '/tmp/mc-t1',
      repo_path: '/fake/repo',
    })

    const result = await handleCompleteTask(db, 't1', 'summary')

    expect(result.ok).toBe(false)
    expect(result.merged).toBe(false)
    expect(result.reason).toContain('merge_conflict')

    const task = getTask(db, 't1')
    expect(task?.status).toBe('failed')
    expect(task?.failure_reason).toBe('merge_conflict')
    expect(task?.conflicted_files).toContain('src/api.ts')
    // worktree kept — conflict worker needs to inspect it
    expect(task?.conflict_branch).toBe('mc/run-run-1')
  })
})
