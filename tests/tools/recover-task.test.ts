import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockKillTmuxWindow, mockReapStaleWindows, mockEnsureTmuxSession } = vi.hoisted(() => ({
  mockKillTmuxWindow: vi.fn(),
  mockReapStaleWindows: vi.fn(),
  mockEnsureTmuxSession: vi.fn(() => 'multiclaude'),
}))

vi.mock('../../src/spawner/tmux.js', () => ({
  killTmuxWindow: mockKillTmuxWindow,
  reapStaleWindows: mockReapStaleWindows,
  ensureTmuxSession: mockEnsureTmuxSession,
  captureTmuxPane: vi.fn(() => ''),
  spawnTmuxWorker: vi.fn(),
  createTmuxWindow: vi.fn(() => '@1'),
  getTmuxPanePid: vi.fn(() => undefined),
  sendTmuxKeys: vi.fn(),
  writeLaunchScript: vi.fn(() => '/tmp/worker-launch.sh'),
  sendToPane: vi.fn(() => ({ sent: true, enterRetries: 0 })),
  capturePaneText: vi.fn(() => ''),
  classifyComposerState: vi.fn(() => 'empty'),
  listTmuxWindows: vi.fn(() => []),
  reapOrphanWindows: vi.fn(),
  windowExists: vi.fn(() => true),
  getChildProcessPid: vi.fn(() => undefined),
  stripAnsiDim: vi.fn((s: string) => s),
  stripBoxDrawing: vi.fn((s: string) => s),
  cleanComposerLine: vi.fn((s: string) => s),
}))

import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask, updateTask, getTask } from '../../src/server/state/tasks.js'
import { registerAgent, updateAgent, getAgent } from '../../src/server/state/agents.js'
import { handleRecoverTask } from '../../src/server/tools/orchestrator.js'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'

// Strip worktree isolation vars that interfere when the test runs inside
// a MultiClaude worktree. Cleared from process.env so simpleGit (used by
// preflightReconcile) also sees the clean environment.
const savedGitEnv = {
  GIT_DIR: process.env.GIT_DIR,
  GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
}
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE
delete process.env.GIT_CEILING_DIRECTORIES

const cleanEnv = { ...process.env }

function git(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, env: cleanEnv, encoding: 'utf8' })
}

describe('recover_task', () => {
  let db: Database.Database
  let repoPath: string

  beforeEach(() => {
    db = createDb(':memory:')
    repoPath = mkdtempSync(join(tmpdir(), 'mc-recover-test-'))
    git('git init', repoPath)
    git('git config user.email "test@test.com"', repoPath)
    git('git config user.name "Test"', repoPath)
    git('echo "init" > README.md && git add . && git commit --no-gpg-sign -m "init"', repoPath)
    mockKillTmuxWindow.mockReset()
    mockReapStaleWindows.mockReset()
    mockEnsureTmuxSession.mockReset()
    mockEnsureTmuxSession.mockReturnValue('multiclaude')
  })

  afterEach(() => {
    closeDb(db)
    try { git('git worktree prune', repoPath) } catch {}
    rmSync(repoPath, { recursive: true, force: true })
  })

  // --- Verdict: unrecoverable ---

  describe('unrecoverable verdicts', () => {
    it('returns unrecoverable when task does not exist', async () => {
      const result = await handleRecoverTask(db, 'nonexistent')
      expect(result.verdict).toBe('unrecoverable')
      expect(result.reason).toContain('not found')
      expect(result.actions).toEqual([])
    })

    it('returns unrecoverable when task is done', async () => {
      createTask(db, { id: 't1', title: 'Done task' })
      updateTask(db, 't1', { status: 'done' })
      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('unrecoverable')
      expect(result.reason).toContain('done')
    })

    it('returns unrecoverable when task is cancelled', async () => {
      createTask(db, { id: 't1', title: 'Cancelled task' })
      updateTask(db, 't1', { status: 'cancelled' })
      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('unrecoverable')
      expect(result.reason).toContain('cancelled')
    })

    it('returns unrecoverable when git reconciliation fails (bad repo path)', async () => {
      createTask(db, { id: 't1', title: 'Bad repo' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'worktree_branch_exists', repo_path: '/nonexistent/path', branch: 'mc/t1' })
      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('unrecoverable')
      expect(result.reason).toContain('Git reconciliation failed')
      expect(result.actions.some(a => !a.success)).toBe(true)
      // Task should NOT be reset when unrecoverable
      const task = getTask(db, 't1')!
      expect(task.status).toBe('failed')
    })
  })

  // --- Verdict: needs_human ---

  describe('needs_human verdicts', () => {
    it('returns needs_human when task is in_progress', async () => {
      createTask(db, { id: 't1', title: 'Active task' })
      updateTask(db, 't1', { status: 'in_progress' })
      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('needs_human')
      expect(result.reason).toContain('in_progress')
    })

    it('returns needs_human for tmux_session_create_failed (resets task)', async () => {
      createTask(db, { id: 't1', title: 'Tmux session fail' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'tmux_session_create_failed' })
      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('needs_human')
      expect(result.reason).toContain('tmux')
      expect(result.actions.some(a => a.action === 'diagnose')).toBe(true)
      expect(result.actions.some(a => a.action === 'reset_task')).toBe(true)
      const task = getTask(db, 't1')!
      expect(task.status).toBe('pending')
      expect(task.failure_reason).toBeNull()
    })

    it('returns needs_human for settings_write_failed (resets task)', async () => {
      createTask(db, { id: 't1', title: 'Settings fail' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'settings_write_failed' })
      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('needs_human')
      expect(result.reason).toContain('permissions')
      expect(result.actions.some(a => a.action === 'diagnose')).toBe(true)
      const task = getTask(db, 't1')!
      expect(task.status).toBe('pending')
    })

    it('returns needs_human when branch is protected (main)', async () => {
      createTask(db, { id: 't1', title: 'Protected branch task' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'worktree_branch_exists', repo_path: repoPath, branch: 'main' })
      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('needs_human')
      expect(result.reason).toContain('protected')
      // Task should NOT be reset
      const task = getTask(db, 't1')!
      expect(task.status).toBe('failed')
    })

    it('returns needs_human when branch is a run integration branch', async () => {
      createTask(db, { id: 't1', title: 'Run branch task' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'worktree_branch_exists', repo_path: repoPath, branch: 'mc/run-abc123' })
      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('needs_human')
      expect(result.reason).toContain('protected')
    })

    it('returns needs_human when preflightReconcile refuses (checked-out branch)', async () => {
      git('git checkout -b feature/current-work', repoPath)
      createTask(db, { id: 't1', title: 'Checked out branch' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'worktree_branch_exists', repo_path: repoPath, branch: 'feature/current-work' })
      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('needs_human')
      expect(result.reason).toContain('Refusing to reconcile')
    })
  })

  // --- Verdict: recovered ---

  describe('recovered verdicts', () => {
    it('returns recovered (noop) when task is already pending with no failure', async () => {
      createTask(db, { id: 't1', title: 'Clean task' })
      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('recovered')
      expect(result.reason).toContain('already in a spawnable state')
      expect(result.actions).toEqual([])
    })

    it('recovers worktree_branch_exists by running git reconcile', async () => {
      git('git branch mc/t1', repoPath)
      createTask(db, { id: 't1', title: 'Branch exists' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'worktree_branch_exists', repo_path: repoPath, branch: 'mc/t1' })

      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('recovered')
      expect(result.actions.some(a => a.action.startsWith('git_reconcile:'))).toBe(true)
      expect(result.actions.some(a => a.action === 'reset_task')).toBe(true)

      const task = getTask(db, 't1')!
      expect(task.status).toBe('pending')
      expect(task.failure_reason).toBeNull()
      expect(task.branch).toBeNull()
    })

    it('recovers worktree_branch_exists: deletes branch with no unique commits', async () => {
      git('git branch mc/t-clean', repoPath)
      createTask(db, { id: 't-clean', title: 'Clean branch' })
      updateTask(db, 't-clean', { status: 'failed', failure_reason: 'worktree_branch_exists', repo_path: repoPath, branch: 'mc/t-clean' })

      const result = await handleRecoverTask(db, 't-clean')
      expect(result.verdict).toBe('recovered')
      expect(result.actions.some(a => a.action === 'git_reconcile:delete-branch')).toBe(true)

      const branches = git('git branch', repoPath)
      expect(branches).not.toContain('mc/t-clean')
    })

    it('recovers worktree_branch_exists: preserves branch with unique commits (allocate-suffix)', async () => {
      git('git checkout -b mc/t-unique', repoPath)
      writeFileSync(join(repoPath, 'work.txt'), 'unique work')
      git('git add . && git commit --no-gpg-sign -m "unique"', repoPath)
      git('git checkout -', repoPath)

      createTask(db, { id: 't-unique', title: 'Unique branch' })
      updateTask(db, 't-unique', { status: 'failed', failure_reason: 'worktree_branch_exists', repo_path: repoPath, branch: 'mc/t-unique' })

      const result = await handleRecoverTask(db, 't-unique')
      expect(result.verdict).toBe('recovered')
      expect(result.actions.some(a => a.action === 'git_reconcile:allocate-suffix')).toBe(true)

      const branches = git('git branch', repoPath)
      expect(branches).toContain('mc/t-unique')
    })

    it('recovers worktree_path_registered by cleaning up the registered worktree', async () => {
      const wtPath = mkdtempSync(join(tmpdir(), 'mc-t-reg-'))
      git(`git worktree add -b mc/t-reg "${wtPath}"`, repoPath)

      createTask(db, { id: 't-reg', title: 'Registered worktree' })
      updateTask(db, 't-reg', { status: 'failed', failure_reason: 'worktree_path_registered', repo_path: repoPath, branch: 'mc/t-reg', worktree_path: wtPath })

      const result = await handleRecoverTask(db, 't-reg')
      expect(result.verdict).toBe('recovered')
      expect(result.actions.some(a => a.action === 'git_reconcile:remove-worktree')).toBe(true)

      const task = getTask(db, 't-reg')!
      expect(task.status).toBe('pending')
      expect(task.worktree_path).toBeNull()

      rmSync(wtPath, { recursive: true, force: true })
    })

    it('recovers worktree failure when branch does not exist (noop reconcile)', async () => {
      createTask(db, { id: 't-gone', title: 'Branch already gone' })
      updateTask(db, 't-gone', { status: 'failed', failure_reason: 'worktree_create_failed', repo_path: repoPath, branch: 'mc/t-gone' })

      const result = await handleRecoverTask(db, 't-gone')
      expect(result.verdict).toBe('recovered')
      expect(result.actions.some(a => a.action === 'git_reconcile:noop')).toBe(true)
    })

    it('recovers worktree failure when no branch is stored (derives mc/{taskId})', async () => {
      git('git branch mc/t-no-branch', repoPath)
      createTask(db, { id: 't-no-branch', title: 'No branch stored' })
      updateTask(db, 't-no-branch', { status: 'failed', failure_reason: 'worktree_branch_exists', repo_path: repoPath })

      const result = await handleRecoverTask(db, 't-no-branch')
      expect(result.verdict).toBe('recovered')
      expect(result.actions.some(a => a.action === 'git_reconcile:delete-branch')).toBe(true)
    })

    it('skips git reconciliation when repo_path is not set', async () => {
      createTask(db, { id: 't1', title: 'No repo path' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'worktree_branch_exists' })

      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('recovered')
      expect(result.actions.some(a => a.action === 'git_reconcile:skip')).toBe(true)
    })

    it('recovers tmux_window_create_failed by reaping stale windows', async () => {
      createTask(db, { id: 't1', title: 'Tmux window fail' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'tmux_window_create_failed' })

      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('recovered')
      expect(mockEnsureTmuxSession).toHaveBeenCalled()
      expect(mockReapStaleWindows).toHaveBeenCalledWith('multiclaude', 't1')
      expect(result.actions.some(a => a.action === 'tmux_reap_stale_windows' && a.success)).toBe(true)

      const task = getTask(db, 't1')!
      expect(task.status).toBe('pending')
    })

    it('recovers tmux_window_create_failed even when tmux is unavailable', async () => {
      mockEnsureTmuxSession.mockImplementation(() => { throw new Error('tmux not found') })
      createTask(db, { id: 't1', title: 'Tmux unavailable' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'tmux_window_create_failed' })

      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('recovered')
      expect(result.actions.some(a => a.action === 'tmux_reap_stale_windows' && !a.success)).toBe(true)
      expect(result.actions.some(a => a.action === 'reset_task')).toBe(true)

      const task = getTask(db, 't1')!
      expect(task.status).toBe('pending')
    })

    it('recovers agent_launch_failed by clearing agent and resetting', async () => {
      createTask(db, { id: 't1', title: 'Launch fail' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'agent_launch_failed', agent_id: 'w-t1' })
      registerAgent(db, { id: 'w-t1', task_id: 't1' })
      updateAgent(db, 'w-t1', { status: 'running' })

      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('recovered')
      expect(result.actions.some(a => a.action === 'mark_agent_failed')).toBe(true)
      expect(result.actions.some(a => a.action === 'reset_task')).toBe(true)

      const agent = getAgent(db, 'w-t1')!
      expect(agent.status).toBe('failed')
      const task = getTask(db, 't1')!
      expect(task.status).toBe('pending')
      expect(task.agent_id).toBeNull()
    })

    it('recovers a task with no failure_reason (status failed only)', async () => {
      createTask(db, { id: 't1', title: 'Generic fail' })
      updateTask(db, 't1', { status: 'failed' })

      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('recovered')
      expect(result.actions.some(a => a.action === 'reset_task')).toBe(true)

      const task = getTask(db, 't1')!
      expect(task.status).toBe('pending')
    })
  })

  // --- Idempotency ---

  describe('idempotency', () => {
    it('second call returns recovered with no actions after first recovery', async () => {
      createTask(db, { id: 't1', title: 'Idempotent' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'agent_launch_failed', agent_id: 'w-t1' })
      registerAgent(db, { id: 'w-t1', task_id: 't1' })

      const result1 = await handleRecoverTask(db, 't1')
      expect(result1.verdict).toBe('recovered')
      expect(result1.actions.length).toBeGreaterThan(0)

      const result2 = await handleRecoverTask(db, 't1')
      expect(result2.verdict).toBe('recovered')
      expect(result2.reason).toContain('already in a spawnable state')
      expect(result2.actions).toEqual([])
    })

    it('second call after git reconcile returns recovered with no actions', async () => {
      git('git branch mc/t-idem', repoPath)
      createTask(db, { id: 't-idem', title: 'Git idempotent' })
      updateTask(db, 't-idem', { status: 'failed', failure_reason: 'worktree_branch_exists', repo_path: repoPath, branch: 'mc/t-idem' })

      const result1 = await handleRecoverTask(db, 't-idem')
      expect(result1.verdict).toBe('recovered')

      const result2 = await handleRecoverTask(db, 't-idem')
      expect(result2.verdict).toBe('recovered')
      expect(result2.actions).toEqual([])
    })
  })

  // --- Agent cleanup ---

  describe('agent cleanup', () => {
    it('kills tmux window when clearing stale agent', async () => {
      createTask(db, { id: 't1', title: 'Agent with pane' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'agent_launch_failed', agent_id: 'w-t1' })
      registerAgent(db, { id: 'w-t1', task_id: 't1' })
      updateAgent(db, 'w-t1', { status: 'running', tmux_pane: '@42' })

      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('recovered')
      expect(mockKillTmuxWindow).toHaveBeenCalledWith('@42')
      expect(result.actions.some(a => a.action === 'kill_agent_tmux_window')).toBe(true)
    })

    it('does not mark agent failed if already failed', async () => {
      createTask(db, { id: 't1', title: 'Already failed agent' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'agent_launch_failed', agent_id: 'w-t1' })
      registerAgent(db, { id: 'w-t1', task_id: 't1' })
      updateAgent(db, 'w-t1', { status: 'failed' })

      const result = await handleRecoverTask(db, 't1')
      expect(result.verdict).toBe('recovered')
      expect(result.actions.some(a => a.action === 'mark_agent_failed')).toBe(false)
    })

    it('does not mark agent failed if already done', async () => {
      createTask(db, { id: 't1', title: 'Done agent' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'agent_launch_failed', agent_id: 'w-t1' })
      registerAgent(db, { id: 'w-t1', task_id: 't1' })
      updateAgent(db, 'w-t1', { status: 'done' })

      const result = await handleRecoverTask(db, 't1')
      expect(result.actions.some(a => a.action === 'mark_agent_failed')).toBe(false)
    })
  })

  // --- Task state after recovery ---

  describe('task state after recovery', () => {
    it('clears all transient fields but preserves repo_path and retry_count', async () => {
      createTask(db, { id: 't1', title: 'Full state' })
      updateTask(db, 't1', {
        status: 'failed',
        failure_reason: 'agent_launch_failed',
        failure_detail: 'ENOENT: spawn claude ENOENT',
        branch: 'mc/t1',
        worktree_path: '/tmp/mc-t1-xxxx',
        head_sha: 'abc123',
        agent_id: 'w-t1',
        started_at: '2026-01-01T00:00:00Z',
        repo_path: repoPath,
        retry_count: 2,
      })
      registerAgent(db, { id: 'w-t1', task_id: 't1' })

      await handleRecoverTask(db, 't1')

      const task = getTask(db, 't1')!
      expect(task.status).toBe('pending')
      expect(task.failure_reason).toBeNull()
      expect(task.failure_detail).toBeNull()
      expect(task.branch).toBeNull()
      expect(task.worktree_path).toBeNull()
      expect(task.head_sha).toBeNull()
      expect(task.agent_id).toBeNull()
      expect(task.started_at).toBeNull()
      // Preserved fields
      expect(task.repo_path).toBe(repoPath)
      expect(task.retry_count).toBe(2)
    })
  })

  // --- Report structure ---

  describe('report structure', () => {
    it('every action has action, success, and detail fields', async () => {
      createTask(db, { id: 't1', title: 'Report test' })
      updateTask(db, 't1', { status: 'failed', failure_reason: 'agent_launch_failed', agent_id: 'w-t1' })
      registerAgent(db, { id: 'w-t1', task_id: 't1' })
      updateAgent(db, 'w-t1', { status: 'running', tmux_pane: '@5' })

      const result = await handleRecoverTask(db, 't1')
      expect(result.task_id).toBe('t1')
      for (const action of result.actions) {
        expect(action).toHaveProperty('action')
        expect(action).toHaveProperty('success')
        expect(action).toHaveProperty('detail')
        expect(typeof action.action).toBe('string')
        expect(typeof action.success).toBe('boolean')
        expect(typeof action.detail).toBe('string')
      }
    })

    it('unrecoverable and needs_human verdicts include a reason', async () => {
      createTask(db, { id: 't-done', title: 'Done' })
      updateTask(db, 't-done', { status: 'done' })
      const r1 = await handleRecoverTask(db, 't-done')
      expect(r1.reason).toBeTruthy()

      createTask(db, { id: 't-ip', title: 'In progress' })
      updateTask(db, 't-ip', { status: 'in_progress' })
      const r2 = await handleRecoverTask(db, 't-ip')
      expect(r2.reason).toBeTruthy()
    })
  })
})
