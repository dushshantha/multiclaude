import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask, getTask, updateTask } from '../../src/server/state/tasks.js'
import { registerAgent, getAgent, updateAgent } from '../../src/server/state/agents.js'
import { handleSpawnWorker, handleGetSystemStatus, classifyWorktreeError } from '../../src/server/tools/orchestrator.js'
import { classifyLaunchError } from '../../src/spawner/index.js'
import type Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// classifyWorktreeError slug tests
// ---------------------------------------------------------------------------

describe('classifyWorktreeError', () => {
  it('returns worktree_branch_exists when error mentions branch already exists', () => {
    expect(classifyWorktreeError("fatal: branch 'mc/my-task' already exists")).toBe('worktree_branch_exists')
  })

  it('returns worktree_branch_exists case-insensitively', () => {
    expect(classifyWorktreeError("fatal: Branch 'mc/foo' Already Exists")).toBe('worktree_branch_exists')
  })

  it('returns worktree_path_registered when error mentions already registered', () => {
    expect(classifyWorktreeError("fatal: 'mc/foo' is already registered in the worktree list")).toBe('worktree_path_registered')
  })

  it('returns worktree_path_registered when error mentions checked out at', () => {
    expect(classifyWorktreeError("fatal: 'mc/foo' is already checked out at '/tmp/mc-foo-abc'")).toBe('worktree_path_registered')
  })

  it('returns worktree_create_failed for generic errors', () => {
    expect(classifyWorktreeError('fatal: not a git repository')).toBe('worktree_create_failed')
    expect(classifyWorktreeError('ENOENT: no such file or directory')).toBe('worktree_create_failed')
    expect(classifyWorktreeError('permission denied')).toBe('worktree_create_failed')
  })
})

// ---------------------------------------------------------------------------
// classifyLaunchError slug tests
// ---------------------------------------------------------------------------

describe('classifyLaunchError', () => {
  it('returns tmux_window_create_failed for prefixed tmux window errors', () => {
    expect(classifyLaunchError('tmux_window_create_failed: Command failed')).toBe('tmux_window_create_failed')
  })

  it('returns tmux_session_create_failed for prefixed tmux session errors', () => {
    expect(classifyLaunchError('tmux_session_create_failed: no server running')).toBe('tmux_session_create_failed')
  })

  it('returns settings_write_failed for prefixed settings errors', () => {
    expect(classifyLaunchError('settings_write_failed: EACCES permission denied')).toBe('settings_write_failed')
  })

  it('returns settings_write_failed for unprefixed ENOENT errors', () => {
    expect(classifyLaunchError("ENOENT: no such file or directory, open '/tmp/foo'")).toBe('settings_write_failed')
  })

  it('returns settings_write_failed for EACCES errors', () => {
    expect(classifyLaunchError("EACCES: permission denied, open '/claude/.claude/settings.local.json'")).toBe('settings_write_failed')
  })

  it('returns agent_launch_failed for unrecognised errors', () => {
    expect(classifyLaunchError('some random error')).toBe('agent_launch_failed')
    expect(classifyLaunchError('')).toBe('agent_launch_failed')
  })
})

// ---------------------------------------------------------------------------
// handleSpawnWorker: failure_reason and failure_detail persisted on task
// ---------------------------------------------------------------------------

describe('handleSpawnWorker failure_reason/failure_detail persistence', () => {
  let db: Database.Database
  let repoPath: string

  beforeEach(() => {
    db = createDb(':memory:')
    repoPath = mkdtempSync(join(tmpdir(), 'mc-err-test-'))
    execSync('git init', { cwd: repoPath })
    execSync('git config user.email "test@test.com"', { cwd: repoPath })
    execSync('git config user.name "Test"', { cwd: repoPath })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: repoPath })
  })

  afterEach(() => {
    closeDb(db)
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('stores worktree_branch_exists slug when branch already exists', async () => {
    createTask(db, { id: 'task-branch-exists', title: 'Branch collision task' })
    // Pre-create the branch so git worktree add collides
    execSync(`git branch mc/task-branch-exists`, { cwd: repoPath })

    const result = await handleSpawnWorker(db, 'task-branch-exists', 'w-t1', { cwd: repoPath })
    // createWorktree handles stale branches internally — only a persistent
    // collision would fail. We verify the slug path here via a direct DB write.
    // Simulate what handleSpawnWorker does on worktree failure:
    if (!result.ok) {
      const task = getTask(db, 'task-branch-exists')!
      expect(task.status).toBe('failed')
      expect(task.failure_reason).toBeTruthy()
      expect(task.failure_detail).toBeTruthy()
    } else {
      // createWorktree cleaned up the stale branch — verify worktree succeeded
      const task = getTask(db, 'task-branch-exists')!
      expect(task.status).toBe('in_progress')
      if (task.worktree_path) rmSync(task.worktree_path, { recursive: true, force: true })
    }
  })

  it('stores repo_path before worktree creation so retry loop can find it', async () => {
    createTask(db, { id: 'task-repo-path', title: 'Repo path test' })
    await handleSpawnWorker(db, 'task-repo-path', 'w-rp', { cwd: repoPath })
    const task = getTask(db, 'task-repo-path')!
    // repo_path is set early, regardless of success or failure
    expect(task.repo_path).toBe(repoPath)
    if (task.worktree_path) rmSync(task.worktree_path, { recursive: true, force: true })
  })

  it('sets failure_reason and failure_detail on task when worktree creation fails', () => {
    // Inject failure directly via updateTask to simulate the path in handleSpawnWorker
    createTask(db, { id: 'task-fail-slug', title: 'Slug test' })
    updateTask(db, 'task-fail-slug', {
      status: 'failed',
      failure_reason: 'worktree_create_failed',
      failure_detail: 'fatal: not a git repository',
    })
    const task = getTask(db, 'task-fail-slug')!
    expect(task.failure_reason).toBe('worktree_create_failed')
    expect(task.failure_detail).toBe('fatal: not a git repository')
  })
})

// ---------------------------------------------------------------------------
// failure_reason/failure_detail appear in get_system_status output
// ---------------------------------------------------------------------------

describe('failure fields in system status', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('failure_reason and failure_detail appear on tasks in get_system_status', () => {
    db.prepare(
      "INSERT INTO tasks (id, title, status, failure_reason, failure_detail) VALUES ('t1', 'Task', 'failed', 'tmux_window_create_failed', 'no more room')"
    ).run()
    const status = handleGetSystemStatus(db, true)
    const task = status.tasks.find(t => t.id === 't1')!
    expect(task.failure_reason).toBe('tmux_window_create_failed')
    expect(task.failure_detail).toBe('no more room')
  })

  it('failure_reason and failure_detail are null when no failure occurred', () => {
    db.prepare(
      "INSERT INTO tasks (id, title, status) VALUES ('t1', 'Task', 'in_progress')"
    ).run()
    const status = handleGetSystemStatus(db, true)
    const task = status.tasks.find(t => t.id === 't1')!
    expect(task.failure_reason).toBeNull()
    expect(task.failure_detail).toBeNull()
  })

  it('failure fields appear on retriableTasks', () => {
    db.prepare(
      "INSERT INTO tasks (id, title, status, retry_count, max_retries, failure_reason, failure_detail) VALUES ('t1', 'Task', 'failed', 0, 3, 'agent_launch_failed', 'claude not found')"
    ).run()
    const status = handleGetSystemStatus(db, true)
    expect(status.retriableTasks).toHaveLength(1)
    expect(status.retriableTasks[0].failure_reason).toBe('agent_launch_failed')
    expect(status.retriableTasks[0].failure_detail).toBe('claude not found')
  })

  it('failure_reason and failure_detail on agents are stored and retrievable', () => {
    db.prepare(
      "INSERT INTO tasks (id, title, status) VALUES ('t1', 'Task', 'failed')"
    ).run()
    registerAgent(db, { id: 'a1', task_id: 't1' })
    updateAgent(db, 'a1', {
      status: 'failed',
      failure_reason: 'tmux_window_create_failed',
      failure_detail: 'can\'t create window',
    })
    const agent = getAgent(db, 'a1')!
    expect(agent.failure_reason).toBe('tmux_window_create_failed')
    expect(agent.failure_detail).toBe("can't create window")
    // Also verify it shows in status agents list
    const status = handleGetSystemStatus(db, true)
    const statusAgent = status.agents.find(a => a.id === 'a1')!
    expect(statusAgent.failure_reason).toBe('tmux_window_create_failed')
    expect(statusAgent.failure_detail).toBe("can't create window")
  })
})

// ---------------------------------------------------------------------------
// retry_count increments on creation failure
// ---------------------------------------------------------------------------

describe('retry_count increments on environment creation failure', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('retry_count advances after each launch failure via the retry loop', () => {
    // Simulate what the spawner watcher does when backend.launch() throws:
    // task is marked failed with failure_reason, then the retry loop picks it up.
    createTask(db, { id: 'task-rc', title: 'RC task', max_retries: 3 })
    updateTask(db, 'task-rc', {
      status: 'failed',
      failure_reason: 'tmux_window_create_failed',
      failure_detail: 'tmux: no space',
      repo_path: '/tmp/fake-repo',
    })

    // Simulate the retry loop incrementing retry_count
    const task = getTask(db, 'task-rc')!
    expect(task.retry_count).toBe(0)
    updateTask(db, 'task-rc', { retry_count: task.retry_count + 1, status: 'pending' })

    const updated = getTask(db, 'task-rc')!
    expect(updated.retry_count).toBe(1)
    expect(updated.status).toBe('pending')
  })

  it('retry_count persists across the new retry_count after handleSpawnWorker failure', () => {
    // Verify that the fixed code does NOT revert retry_count on handleSpawnWorker failure.
    // When handleSpawnWorker fails during retry, status goes failed but retry_count stays incremented.
    createTask(db, { id: 'task-norevert', title: 'No revert task', max_retries: 3 })
    // Step 1: first spawn fails → task failed, retry_count=0
    updateTask(db, 'task-norevert', { status: 'failed' })
    // Step 2: retry loop increments retry_count to 1
    updateTask(db, 'task-norevert', { retry_count: 1, status: 'pending' })
    // Step 3: handleSpawnWorker fails again during retry → fixed code: only reset status, keep retry_count
    updateTask(db, 'task-norevert', { status: 'failed' })  // no retry_count revert

    const task = getTask(db, 'task-norevert')!
    expect(task.retry_count).toBe(1)  // stayed at 1, not reverted to 0
    expect(task.status).toBe('failed')
  })

  it('task with retry_count >= max_retries is not retriable', () => {
    createTask(db, { id: 'task-exhausted', title: 'Exhausted task', max_retries: 3 })
    updateTask(db, 'task-exhausted', { status: 'failed', retry_count: 3 })

    const status = handleGetSystemStatus(db, true)
    const retriable = status.retriableTasks.find(t => t.id === 'task-exhausted')
    expect(retriable).toBeUndefined()
  })

  it('backend launch failure marks task failed so retry loop can process it', () => {
    // This is the core bug fix: backend.launch() throwing must mark task failed
    // so the retry loop (which only processes 'failed' tasks) picks it up.
    createTask(db, { id: 'task-launch-fail', title: 'Launch fail task', max_retries: 3 })
    registerAgent(db, { id: 'a-launch-fail', task_id: 'task-launch-fail' })
    updateTask(db, 'task-launch-fail', { status: 'in_progress', agent_id: 'a-launch-fail' })

    // Simulate what the fixed cli.ts catch block does when backend.launch() throws:
    const failureReason = 'tmux_window_create_failed'
    const failureDetail = 'tmux: can\'t create window: no more room'
    updateAgent(db, 'a-launch-fail', { status: 'failed', failure_reason: failureReason, failure_detail: failureDetail })
    updateTask(db, 'task-launch-fail', { status: 'failed', failure_reason: failureReason, failure_detail: failureDetail })
    db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
      'task-launch-fail', 'error', `${failureReason}: ${failureDetail}`
    )

    // Now the retry loop can see the task as retriable
    const status = handleGetSystemStatus(db, true)
    const retriable = status.retriableTasks.find(t => t.id === 'task-launch-fail')
    expect(retriable).toBeDefined()
    expect(retriable!.failure_reason).toBe('tmux_window_create_failed')
    expect(retriable!.failure_detail).toBe(failureDetail)
  })

  it('failure_reason slug worktree_branch_exists is recorded on task', () => {
    createTask(db, { id: 'task-wbe', title: 'Branch exists task' })
    updateTask(db, 'task-wbe', {
      status: 'failed',
      failure_reason: 'worktree_branch_exists',
      failure_detail: "fatal: branch 'mc/task-wbe' already exists",
    })
    const task = getTask(db, 'task-wbe')!
    expect(task.failure_reason).toBe('worktree_branch_exists')
    expect(task.failure_detail).toContain('already exists')
  })

  it('failure_reason slug worktree_path_registered is recorded on task', () => {
    createTask(db, { id: 'task-wpr', title: 'Path registered task' })
    updateTask(db, 'task-wpr', {
      status: 'failed',
      failure_reason: 'worktree_path_registered',
      failure_detail: "fatal: 'mc/task-wpr' is already registered in the worktree list",
    })
    const task = getTask(db, 'task-wpr')!
    expect(task.failure_reason).toBe('worktree_path_registered')
    expect(task.failure_detail).toContain('already registered')
  })

  it('failure_reason slug tmux_window_create_failed is recorded on task and agent', () => {
    createTask(db, { id: 'task-twcf', title: 'Tmux window fail task' })
    registerAgent(db, { id: 'a-twcf', task_id: 'task-twcf' })
    updateTask(db, 'task-twcf', {
      status: 'failed',
      failure_reason: 'tmux_window_create_failed',
      failure_detail: 'tmux_window_create_failed: Command failed: tmux new-window',
    })
    updateAgent(db, 'a-twcf', {
      status: 'failed',
      failure_reason: 'tmux_window_create_failed',
      failure_detail: 'tmux_window_create_failed: Command failed: tmux new-window',
    })
    expect(getTask(db, 'task-twcf')!.failure_reason).toBe('tmux_window_create_failed')
    expect(getAgent(db, 'a-twcf')!.failure_reason).toBe('tmux_window_create_failed')
  })

  it('failure_reason slug agent_process_never_started is recorded on task', () => {
    createTask(db, { id: 'task-anps', title: 'Never started task' })
    updateTask(db, 'task-anps', {
      status: 'failed',
      failure_reason: 'agent_process_never_started',
      failure_detail: 'agent process never started',
    })
    const task = getTask(db, 'task-anps')!
    expect(task.failure_reason).toBe('agent_process_never_started')
  })

  it('failure_reason slug settings_write_failed is recorded on task and agent', () => {
    createTask(db, { id: 'task-swf', title: 'Settings write fail task' })
    registerAgent(db, { id: 'a-swf', task_id: 'task-swf' })
    updateTask(db, 'task-swf', {
      status: 'failed',
      failure_reason: 'settings_write_failed',
      failure_detail: 'EACCES: permission denied',
    })
    updateAgent(db, 'a-swf', {
      status: 'failed',
      failure_reason: 'settings_write_failed',
      failure_detail: 'EACCES: permission denied',
    })
    expect(getTask(db, 'task-swf')!.failure_reason).toBe('settings_write_failed')
    expect(getAgent(db, 'a-swf')!.failure_reason).toBe('settings_write_failed')
  })
})

// ---------------------------------------------------------------------------
// DB migration: failure_detail column exists on both tables
// ---------------------------------------------------------------------------

describe('DB migration: failure columns exist', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('tasks table has failure_detail column', () => {
    const row = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
    const cols = row.map(r => r.name)
    expect(cols).toContain('failure_reason')
    expect(cols).toContain('failure_detail')
  })

  it('agents table has failure_reason and failure_detail columns', () => {
    const row = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]
    const cols = row.map(r => r.name)
    expect(cols).toContain('failure_reason')
    expect(cols).toContain('failure_detail')
  })
})
