import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock tmux so handleRecoverTask doesn't need a real tmux session.
const { mockKillTmuxWindow, mockEnsureTmuxSession, mockReapStaleWindows } = vi.hoisted(() => ({
  mockKillTmuxWindow: vi.fn(),
  mockEnsureTmuxSession: vi.fn(() => 'multiclaude'),
  mockReapStaleWindows: vi.fn(),
}))

vi.mock('../../src/spawner/tmux.js', () => ({
  killTmuxWindow: mockKillTmuxWindow,
  ensureTmuxSession: mockEnsureTmuxSession,
  reapStaleWindows: mockReapStaleWindows,
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
import { createTask, getTask, updateTask } from '../../src/server/state/tasks.js'
import { handleSpawnWorker } from '../../src/server/tools/orchestrator.js'
import {
  shouldAttemptRecovery,
  applyRecoveryOutcome,
  MAX_RECOVERY_ATTEMPTS,
} from '../../src/spawner/auto-recovery.js'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import type { Task } from '../../src/server/state/tasks.js'

// Strip worktree isolation vars so simpleGit works against a real test repo.
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE
delete process.env.GIT_CEILING_DIRECTORIES

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Test task',
    description: null,
    status: 'failed',
    model: 'sonnet',
    effort: 'high',
    retry_count: 0,
    max_retries: 3,
    worktree_path: null,
    branch: null,
    head_sha: null,
    repo_path: null,
    agent_id: null,
    started_at: null,
    duration_seconds: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cost_usd: null,
    run_id: null,
    ticket: null,
    failure_reason: 'worktree_branch_exists',
    failure_detail: null,
    recovery_attempts: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

// ─── shouldAttemptRecovery ────────────────────────────────────────────────────

describe('shouldAttemptRecovery', () => {
  it('returns true when task has a failure_reason and is under the cap', () => {
    expect(shouldAttemptRecovery(makeTask({ failure_reason: 'worktree_branch_exists', recovery_attempts: 0 }))).toBe(true)
    expect(shouldAttemptRecovery(makeTask({ failure_reason: 'agent_launch_failed', recovery_attempts: MAX_RECOVERY_ATTEMPTS - 1 }))).toBe(true)
  })

  it('returns false when recovery_attempts has hit the cap', () => {
    expect(shouldAttemptRecovery(makeTask({ failure_reason: 'worktree_branch_exists', recovery_attempts: MAX_RECOVERY_ATTEMPTS }))).toBe(false)
    expect(shouldAttemptRecovery(makeTask({ failure_reason: 'worktree_branch_exists', recovery_attempts: MAX_RECOVERY_ATTEMPTS + 1 }))).toBe(false)
  })

  it('returns false when there is no failure_reason', () => {
    expect(shouldAttemptRecovery(makeTask({ failure_reason: null, recovery_attempts: 0 }))).toBe(false)
  })
})

// ─── applyRecoveryOutcome ─────────────────────────────────────────────────────

describe('applyRecoveryOutcome', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    createTask(db, { id: 't1', title: 'Test task', max_retries: 3 })
    updateTask(db, 't1', { status: 'failed', failure_reason: 'worktree_branch_exists', recovery_attempts: 0 })
  })

  afterEach(() => {
    closeDb(db)
  })

  describe('recovered verdict', () => {
    it('returns respawn and increments recovery_attempts', () => {
      const task = getTask(db, 't1')!
      const outcome = applyRecoveryOutcome(db, task, { task_id: 't1', verdict: 'recovered', actions: [] })

      expect(outcome).toBe('respawn')
      const updated = getTask(db, 't1')!
      expect(updated.recovery_attempts).toBe(1)
      // Status is not changed by applyRecoveryOutcome on success (handleRecoverTask already reset it to pending)
      expect(updated.failure_reason).toBe('worktree_branch_exists')  // applyRecoveryOutcome doesn't touch failure_reason on success
    })

    it('writes an info log for the recovery attempt', () => {
      const task = getTask(db, 't1')!
      applyRecoveryOutcome(db, task, { task_id: 't1', verdict: 'recovered', actions: [] })

      const log = db.prepare(
        "SELECT level, message FROM logs WHERE task_id = 't1' ORDER BY id DESC LIMIT 1"
      ).get() as { level: string; message: string }
      expect(log.level).toBe('info')
      expect(log.message).toContain('Auto-recovery attempt 1')
      expect(log.message).toContain('recovered')
    })

    it('increments from the captured snapshot value, not the DB value', () => {
      // recovery_attempts = 1 in the snapshot
      updateTask(db, 't1', { recovery_attempts: 1 })
      const task = getTask(db, 't1')!
      expect(task.recovery_attempts).toBe(1)

      applyRecoveryOutcome(db, task, { task_id: 't1', verdict: 'recovered', actions: [] })

      const updated = getTask(db, 't1')!
      expect(updated.recovery_attempts).toBe(2)
    })
  })

  describe('needs_human verdict', () => {
    it('returns escalate and exhausts retry_count', () => {
      const task = getTask(db, 't1')!
      const outcome = applyRecoveryOutcome(db, task, {
        task_id: 't1',
        verdict: 'needs_human',
        reason: 'tmux session creation failed',
        actions: [],
      })

      expect(outcome).toBe('escalate')
      const updated = getTask(db, 't1')!
      expect(updated.retry_count).toBe(3)  // max_retries — excluded from future retry loops
      expect(updated.status).toBe('failed')
      expect(updated.failure_reason).toBe('needs_human')
      expect(updated.failure_detail).toContain('tmux session creation failed')
      expect(updated.recovery_attempts).toBe(1)
    })

    it('writes an error log for the recovery attempt', () => {
      const task = getTask(db, 't1')!
      applyRecoveryOutcome(db, task, {
        task_id: 't1',
        verdict: 'needs_human',
        reason: 'requires manual fix',
        actions: [],
      })

      const log = db.prepare(
        "SELECT level, message FROM logs WHERE task_id = 't1' ORDER BY id DESC LIMIT 1"
      ).get() as { level: string; message: string }
      expect(log.level).toBe('error')
      expect(log.message).toContain('needs_human')
      expect(log.message).toContain('requires manual fix')
    })

    it('task is NOT picked up by a subsequent failed-task scan (retry exhausted)', () => {
      const task = getTask(db, 't1')!
      applyRecoveryOutcome(db, task, { task_id: 't1', verdict: 'needs_human', reason: 'env broken', actions: [] })

      const updated = getTask(db, 't1')!
      // Simulated retry filter: status='failed' AND retry_count < max_retries
      expect(updated.status).toBe('failed')
      expect(updated.retry_count).toBe(updated.max_retries)
      // → filter excludes it (retry_count < max_retries is false)
    })
  })

  describe('unrecoverable verdict', () => {
    it('returns escalate and exhausts retry_count', () => {
      const task = getTask(db, 't1')!
      const outcome = applyRecoveryOutcome(db, task, {
        task_id: 't1',
        verdict: 'unrecoverable',
        reason: 'git reconciliation failed',
        actions: [],
      })

      expect(outcome).toBe('escalate')
      const updated = getTask(db, 't1')!
      expect(updated.retry_count).toBe(3)
      expect(updated.failure_reason).toBe('unrecoverable')
      expect(updated.failure_detail).toContain('git reconciliation failed')
    })
  })
})

// ─── Recovery cap ─────────────────────────────────────────────────────────────

describe('recovery cap behaviour', () => {
  it('shouldAttemptRecovery returns false when cap is reached', () => {
    const task = makeTask({ failure_reason: 'tmux_window_create_failed', recovery_attempts: MAX_RECOVERY_ATTEMPTS })
    expect(shouldAttemptRecovery(task)).toBe(false)
  })

  it('task with recovery_attempts at cap is identified as needing escalation rather than recovery', () => {
    // Callers should check shouldAttemptRecovery first; when it returns false
    // for a task with a failure_reason, they escalate permanently.
    const task = makeTask({ failure_reason: 'worktree_branch_exists', recovery_attempts: MAX_RECOVERY_ATTEMPTS })
    expect(shouldAttemptRecovery(task)).toBe(false)
    expect(task.failure_reason).toBeTruthy()  // there IS a failure_reason, but cap is hit
  })
})

// ─── Integration: recovery succeeds → re-spawn proceeds ──────────────────────

describe('integration: recovery succeeds and re-spawn proceeds', () => {
  let db: Database.Database
  let repoPath: string

  beforeEach(() => {
    db = createDb(':memory:')
    repoPath = mkdtempSync(join(tmpdir(), 'mc-ar-test-'))
    execSync('git init', { cwd: repoPath })
    execSync('git config user.email "test@test.com"', { cwd: repoPath })
    execSync('git config user.name "Test"', { cwd: repoPath })
    execSync('echo "init" > README.md && git add . && git commit --no-gpg-sign -m "init"', { cwd: repoPath })
    mockKillTmuxWindow.mockReset()
    mockEnsureTmuxSession.mockReset()
    mockEnsureTmuxSession.mockReturnValue('multiclaude')
  })

  afterEach(() => {
    closeDb(db)
    try { execSync('git worktree prune', { cwd: repoPath }) } catch {}
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('after applyRecoveryOutcome(recovered), handleSpawnWorker succeeds without incrementing retry_count', async () => {
    createTask(db, { id: 't-respawn', title: 'Respawn test' })
    updateTask(db, 't-respawn', {
      status: 'failed',
      failure_reason: 'worktree_branch_exists',
      recovery_attempts: 0,
      repo_path: repoPath,
    })

    const task = getTask(db, 't-respawn')!
    expect(task.retry_count).toBe(0)

    // Simulate: handleRecoverTask returned 'recovered' (environment repaired, task reset to pending)
    updateTask(db, 't-respawn', {
      status: 'pending',
      failure_reason: undefined,  // cleared by handleRecoverTask
      agent_id: undefined,
      worktree_path: undefined,
      branch: undefined,
      head_sha: undefined,
    })
    const outcome = applyRecoveryOutcome(db, task, { task_id: 't-respawn', verdict: 'recovered', actions: [] })
    expect(outcome).toBe('respawn')

    // Re-spawn: retry_count must NOT be incremented
    const result = await handleSpawnWorker(db, 't-respawn', 'w-t-respawn-r1', { cwd: repoPath })
    expect(result.ok).toBe(true)

    const afterSpawn = getTask(db, 't-respawn')!
    expect(afterSpawn.status).toBe('in_progress')
    expect(afterSpawn.retry_count).toBe(0)   // <-- key assertion: retry NOT consumed
    expect(afterSpawn.recovery_attempts).toBe(1)

    // Cleanup worktree
    if (afterSpawn.worktree_path) {
      try { rmSync(afterSpawn.worktree_path, { recursive: true, force: true }) } catch {}
    }
  })

  it('needs_human verdict surfaces to orchestrator without further retries', async () => {
    createTask(db, { id: 't-nh', title: 'Needs human test', max_retries: 3 })
    updateTask(db, 't-nh', {
      status: 'failed',
      failure_reason: 'tmux_session_create_failed',
      recovery_attempts: 0,
    })

    const task = getTask(db, 't-nh')!
    expect(shouldAttemptRecovery(task)).toBe(true)

    applyRecoveryOutcome(db, task, {
      task_id: 't-nh',
      verdict: 'needs_human',
      reason: 'Tmux session creation previously failed — ensure tmux is available before re-spawning',
      actions: [],
    })

    const updated = getTask(db, 't-nh')!
    // Orchestrator sees failure_reason='needs_human' with full context
    expect(updated.failure_reason).toBe('needs_human')
    expect(updated.failure_detail).toContain('tmux')

    // No further retries: retry_count exhausted
    expect(updated.retry_count).toBe(updated.max_retries)
    expect(updated.status).toBe('failed')

    // Verify the retry loop filter would exclude this task
    const retriableCount = db.prepare(
      "SELECT COUNT(*) AS cnt FROM tasks WHERE status = 'failed' AND retry_count < max_retries AND id = 't-nh'"
    ).get() as { cnt: number }
    expect(retriableCount.cnt).toBe(0)
  })

  it('recovery cap reached: task fails permanently without consuming a retry', () => {
    createTask(db, { id: 't-cap', title: 'Cap test', max_retries: 3 })
    updateTask(db, 't-cap', {
      status: 'failed',
      failure_reason: 'worktree_branch_exists',
      recovery_attempts: MAX_RECOVERY_ATTEMPTS,
    })

    const task = getTask(db, 't-cap')!
    expect(shouldAttemptRecovery(task)).toBe(false)  // cap gate fires

    // Caller (cli.ts) permanently fails the task when cap is hit
    updateTask(db, 't-cap', {
      status: 'failed',
      retry_count: task.max_retries,
      failure_reason: 'recovery_cap_reached',
      failure_detail: `Auto-recovery attempted ${MAX_RECOVERY_ATTEMPTS} times without success`,
    })

    const updated = getTask(db, 't-cap')!
    expect(updated.failure_reason).toBe('recovery_cap_reached')
    expect(updated.retry_count).toBe(updated.max_retries)
    // Verify it is excluded from the retry loop
    const retriable = db.prepare(
      "SELECT COUNT(*) AS cnt FROM tasks WHERE status = 'failed' AND retry_count < max_retries AND id = 't-cap'"
    ).get() as { cnt: number }
    expect(retriable.cnt).toBe(0)
  })
})
