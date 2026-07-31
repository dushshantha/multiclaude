/**
 * Tests for merge failure attribution fix (#101):
 * - Cleanup errors must not be reported as "merge failed"
 * - Ancestor check before marking failed (secondary defense)
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
import type Database from 'better-sqlite3'

function setupTask(db: Database.Database, id = 't1') {
  createTask(db, { id, title: 'Test task' })
  updateTask(db, id, {
    status: 'in_progress',
    worktree_path: '/tmp/fake-worktree',
    branch: 'feature/test',
    head_sha: null, // skip empty-branch check; we test merge behavior only
    repo_path: '/fake/repo',
  })
}

describe('handleReportDone — merge failure attribution', () => {
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

  describe('primary fix: cleanup error outside merge try/catch', () => {
    it('marks task done when merge succeeds but removeWorktree throws', async () => {
      setupTask(db)
      mockRemoveWorktree.mockRejectedValue(
        new Error('cannot use simple-git on a directory that does not exist')
      )

      await handleReportDone(db, 't1', 'feature done')

      const task = getTask(db, 't1')
      expect(task?.status).toBe('done')
      expect(task?.failure_reason).toBeNull()
    })

    it('records cleanup error as a warn log with post_merge_cleanup_failed reason', async () => {
      setupTask(db)
      mockRemoveWorktree.mockRejectedValue(new Error('worktree already removed'))

      await handleReportDone(db, 't1', 'done')

      const warnLog = db.prepare(
        "SELECT message FROM logs WHERE task_id = 't1' AND level = 'warn'"
      ).get() as { message: string } | undefined
      expect(warnLog?.message).toContain('post_merge_cleanup_failed')
      expect(warnLog?.message).toContain('worktree already removed')
    })

    it('does NOT write an error log when only cleanup fails', async () => {
      setupTask(db)
      mockRemoveWorktree.mockRejectedValue(new Error('cleanup error'))

      await handleReportDone(db, 't1', 'done')

      const errorLog = db.prepare(
        "SELECT message FROM logs WHERE task_id = 't1' AND level = 'error'"
      ).get()
      expect(errorLog).toBeUndefined()
    })
  })

  describe('genuine merge failure', () => {
    it('marks task failed with failure_reason "merge failed" when merge does not land', async () => {
      setupTask(db)
      mockMergeWorktreeBranch.mockRejectedValue(new Error('git merge returned non-zero exit'))
      mockIsMergedInto.mockResolvedValue(false)

      await handleReportDone(db, 't1', 'done')

      const task = getTask(db, 't1')
      expect(task?.status).toBe('failed')
      expect(task?.failure_reason).toBe('merge failed')
    })

    it('writes an error log on genuine merge failure', async () => {
      setupTask(db)
      mockMergeWorktreeBranch.mockRejectedValue(new Error('git merge failed'))
      mockIsMergedInto.mockResolvedValue(false)

      await handleReportDone(db, 't1', 'done')

      const errorLog = db.prepare(
        "SELECT message FROM logs WHERE task_id = 't1' AND level = 'error'"
      ).get() as { message: string } | undefined
      expect(errorLog?.message).toContain('Merge failed')
      expect(errorLog?.message).toContain('feature/test')
    })
  })

  describe('secondary defense: ancestor check before marking failed', () => {
    it('marks task done when mergeWorktreeBranch throws but branch is already an ancestor', async () => {
      setupTask(db)
      mockMergeWorktreeBranch.mockRejectedValue(new Error('push to origin failed'))
      mockIsMergedInto.mockResolvedValue(true)

      await handleReportDone(db, 't1', 'done')

      const task = getTask(db, 't1')
      expect(task?.status).toBe('done')
      expect(task?.failure_reason).toBeNull()
    })

    it('records the post-merge error as a warn when ancestor check passes', async () => {
      setupTask(db)
      mockMergeWorktreeBranch.mockRejectedValue(new Error('post-merge verification error'))
      mockIsMergedInto.mockResolvedValue(true)

      await handleReportDone(db, 't1', 'done')

      const warnLog = db.prepare(
        "SELECT message FROM logs WHERE task_id = 't1' AND level = 'warn'"
      ).get() as { message: string } | undefined
      expect(warnLog?.message).toContain('post_merge_cleanup_failed')
      expect(warnLog?.message).toContain('post-merge verification error')
    })

    it('marks task failed when mergeWorktreeBranch throws AND ancestor check returns false', async () => {
      setupTask(db)
      mockMergeWorktreeBranch.mockRejectedValue(new Error('merge conflict'))
      mockIsMergedInto.mockResolvedValue(false)

      await handleReportDone(db, 't1', 'done')

      const task = getTask(db, 't1')
      expect(task?.status).toBe('failed')
      expect(task?.failure_reason).toBe('merge failed')
    })

    it('falls back to "not landed" when isMergedInto itself throws', async () => {
      setupTask(db)
      mockMergeWorktreeBranch.mockRejectedValue(new Error('merge error'))
      mockIsMergedInto.mockRejectedValue(new Error('git unavailable'))

      await handleReportDone(db, 't1', 'done')

      const task = getTask(db, 't1')
      expect(task?.status).toBe('failed')
      expect(task?.failure_reason).toBe('merge failed')
    })
  })
})
