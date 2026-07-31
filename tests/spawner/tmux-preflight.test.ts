/**
 * Tests for pre-spawn stale-window reaping, post-creation window verification,
 * and orphan-window reaping for mc-* windows belonging to terminal tasks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockExecSync, mockSpawn, mockWriteFileSync, mockMkdirSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockSpawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
}))

vi.mock('child_process', () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
}))

vi.mock('fs', () => ({
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  openSync: vi.fn(() => 1),
}))

import {
  listTmuxWindows,
  windowExists,
  reapStaleWindows,
  reapOrphanWindows,
  spawnTmuxWorker,
} from '../../src/spawner/tmux.js'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask, updateTask } from '../../src/server/state/tasks.js'
import { registerAgent, updateAgent } from '../../src/server/state/agents.js'
import type Database from 'better-sqlite3'

// ─────────────────────────────────────────────────────────────────────────────
// listTmuxWindows
// ─────────────────────────────────────────────────────────────────────────────

describe('listTmuxWindows', () => {
  beforeEach(() => { mockExecSync.mockReset() })

  it('parses window list into id/name pairs', () => {
    mockExecSync.mockReturnValueOnce('@1 bash\n@2 mc-w-task-1\n@3 mc-w-task-2-retry1\n')
    const result = listTmuxWindows('multiclaude')
    expect(result).toEqual([
      { windowId: '@1', windowName: 'bash' },
      { windowId: '@2', windowName: 'mc-w-task-1' },
      { windowId: '@3', windowName: 'mc-w-task-2-retry1' },
    ])
  })

  it('returns empty array when session has no windows', () => {
    mockExecSync.mockReturnValueOnce('\n')
    expect(listTmuxWindows('multiclaude')).toEqual([])
  })

  it('returns empty array when tmux throws', () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('no server') })
    expect(listTmuxWindows('multiclaude')).toEqual([])
  })

  it('filters out lines without a valid @NN id', () => {
    mockExecSync.mockReturnValueOnce('bad-line\n@5 my-window\n')
    const result = listTmuxWindows('multiclaude')
    expect(result).toHaveLength(1)
    expect(result[0].windowId).toBe('@5')
  })

  it('calls list-windows with the correct session name', () => {
    mockExecSync.mockReturnValueOnce('')
    listTmuxWindows('my-session')
    const cmd = mockExecSync.mock.calls[0][0] as string
    expect(cmd).toContain('list-windows')
    expect(cmd).toContain('my-session')
    expect(cmd).toContain('#{window_id}')
    expect(cmd).toContain('#{window_name}')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// windowExists
// ─────────────────────────────────────────────────────────────────────────────

describe('windowExists', () => {
  beforeEach(() => { mockExecSync.mockReset() })

  it('returns true when display-message succeeds', () => {
    mockExecSync.mockReturnValueOnce('')
    expect(windowExists('@42')).toBe(true)
  })

  it('returns false when display-message throws (window gone)', () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('no such window') })
    expect(windowExists('@42')).toBe(false)
  })

  it('targets the @NN window ID with display-message', () => {
    mockExecSync.mockReturnValueOnce('')
    windowExists('@99')
    const cmd = mockExecSync.mock.calls[0][0] as string
    expect(cmd).toContain('display-message')
    expect(cmd).toContain('@99')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// reapStaleWindows — pre-spawn reaping
// ─────────────────────────────────────────────────────────────────────────────

describe('reapStaleWindows', () => {
  beforeEach(() => { mockExecSync.mockReset() })

  it('kills windows whose name matches mc-w-{taskId} exactly', () => {
    // list-windows returns one exact-match window
    mockExecSync.mockReturnValueOnce('@2 mc-w-task-42\n')
    // kill-window call
    mockExecSync.mockReturnValueOnce(undefined)

    reapStaleWindows('multiclaude', 'task-42')

    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    const killCall = calls.find(c => c.includes('kill-window'))
    expect(killCall).toBeDefined()
    expect(killCall).toContain('@2')
  })

  it('kills windows whose name starts with mc-w-{taskId}- (retry windows)', () => {
    mockExecSync.mockReturnValueOnce('@3 mc-w-task-42-retry1\n@4 mc-w-task-42-retry2\n')
    mockExecSync.mockReturnValueOnce(undefined) // kill @3
    mockExecSync.mockReturnValueOnce(undefined) // kill @4

    reapStaleWindows('multiclaude', 'task-42')

    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    const killCalls = calls.filter(c => c.includes('kill-window'))
    expect(killCalls).toHaveLength(2)
    expect(killCalls[0]).toContain('@3')
    expect(killCalls[1]).toContain('@4')
  })

  it('does not kill windows for a different task with a similar prefix', () => {
    // task-4 should NOT kill mc-w-task-42
    mockExecSync.mockReturnValueOnce('@2 mc-w-task-42\n')

    reapStaleWindows('multiclaude', 'task-4')

    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    expect(calls.some(c => c.includes('kill-window'))).toBe(false)
  })

  it('does not kill non-mc windows', () => {
    mockExecSync.mockReturnValueOnce('@1 bash\n@2 zsh\n')

    reapStaleWindows('multiclaude', 'task-42')

    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    expect(calls.some(c => c.includes('kill-window'))).toBe(false)
  })

  it('is a no-op when no windows match', () => {
    mockExecSync.mockReturnValueOnce('@1 mc-w-task-99\n')

    reapStaleWindows('multiclaude', 'task-42')

    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    expect(calls.some(c => c.includes('kill-window'))).toBe(false)
  })

  it('kills by @NN window ID, not by window name', () => {
    mockExecSync.mockReturnValueOnce('@7 mc-w-task-42\n')
    mockExecSync.mockReturnValueOnce(undefined)

    reapStaleWindows('multiclaude', 'task-42')

    const killCall = mockExecSync.mock.calls.map(c => c[0] as string).find(c => c.includes('kill-window'))!
    expect(killCall).toContain('@7')
    expect(killCall).not.toContain('mc-w-task-42')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// spawnTmuxWorker — pre-spawn reaping + post-creation verification
// ─────────────────────────────────────────────────────────────────────────────

describe('spawnTmuxWorker — preflight reaping and window verification', () => {
  const cfg = {
    taskId: 'task-42',
    taskTitle: 'Build the thing',
    agentId: 'w-task-42',
    worktreePath: '/tmp/wt-42',
    mcpConfigPath: '/tmp/mcp.json',
  }

  beforeEach(() => {
    mockExecSync.mockReset()
    mockSpawn.mockReset()
    mockWriteFileSync.mockReset()
    mockMkdirSync.mockReset()
    mockSpawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() })
    delete process.env.TMUX
  })

  afterEach(() => { delete process.env.TMUX })

  function setupSpawnMocks({
    listWindows = '',
    windowId = '@42',
    windowExistsResult = true,
    pid = '9999\n',
  } = {}) {
    mockExecSync.mockReturnValueOnce(undefined)       // has-session
    mockExecSync.mockReturnValueOnce(listWindows)     // list-windows (reapStaleWindows)
    mockExecSync.mockReturnValueOnce(`${windowId}\n`) // new-window
    if (windowExistsResult) {
      mockExecSync.mockReturnValueOnce(undefined)     // windowExists → success
    } else {
      mockExecSync.mockImplementationOnce(() => { throw new Error('no such window') }) // windowExists → fail
    }
    mockExecSync.mockReturnValueOnce(pid)             // pane PID
    mockExecSync.mockReturnValueOnce(undefined)       // send-keys
  }

  it('calls list-windows before new-window to reap stale windows', () => {
    setupSpawnMocks()
    spawnTmuxWorker(cfg)
    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    const listIdx = calls.findIndex(c => c.includes('list-windows'))
    const newWinIdx = calls.findIndex(c => c.includes('new-window'))
    expect(listIdx).toBeGreaterThanOrEqual(0)
    expect(newWinIdx).toBeGreaterThan(listIdx)
  })

  it('kills a stale window for this task before spawning a new one', () => {
    // list-windows returns a stale window for the same task
    mockExecSync.mockReturnValueOnce(undefined)                           // has-session
    mockExecSync.mockReturnValueOnce('@5 mc-w-task-42\n')                 // list-windows
    mockExecSync.mockReturnValueOnce(undefined)                           // kill-window @5
    mockExecSync.mockReturnValueOnce('@42\n')                             // new-window
    mockExecSync.mockReturnValueOnce(undefined)                           // windowExists
    mockExecSync.mockReturnValueOnce('9999\n')                            // pane PID
    mockExecSync.mockReturnValueOnce(undefined)                           // send-keys

    spawnTmuxWorker(cfg)

    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    const killCall = calls.find(c => c.includes('kill-window') && c.includes('@5'))
    expect(killCall).toBeDefined()
  })

  it('calls windowExists after createTmuxWindow using the returned @NN id', () => {
    setupSpawnMocks({ windowId: '@77' })
    spawnTmuxWorker(cfg)
    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    const existsCall = calls.find(c => c.includes('display-message') && c.includes('@77'))
    expect(existsCall).toBeDefined()
  })

  it('throws a structured error when the window does not exist after creation', () => {
    setupSpawnMocks({ windowExistsResult: false })
    expect(() => spawnTmuxWorker(cfg)).toThrow(/tmux_window_create_failed/)
  })

  it('includes the window name in the creation-failure error', () => {
    setupSpawnMocks({ windowExistsResult: false })
    expect(() => spawnTmuxWorker(cfg)).toThrow(/mc-w-task-42/)
  })

  it('does not call sendTmuxKeys when window verification fails', () => {
    setupSpawnMocks({ windowExistsResult: false })
    try { spawnTmuxWorker(cfg) } catch { /* expected */ }
    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    expect(calls.some(c => c.includes('send-keys'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// reapOrphanWindows — cleanup of mc-* windows for terminal tasks
// ─────────────────────────────────────────────────────────────────────────────

describe('reapOrphanWindows', () => {
  let db: Database.Database

  beforeEach(() => {
    mockExecSync.mockReset()
    db = createDb(':memory:')
    delete process.env.TMUX
  })

  afterEach(() => {
    closeDb(db)
    delete process.env.TMUX
  })

  function mockListWindows(output: string) {
    // ensureTmuxSession: has-session check
    mockExecSync.mockReturnValueOnce(undefined)
    // listTmuxWindows: list-windows
    mockExecSync.mockReturnValueOnce(output)
  }

  it('kills mc-* windows whose task is in done state', () => {
    createTask(db, { id: 't1', title: 'T1' })
    updateTask(db, 't1', { status: 'done' })
    registerAgent(db, { id: 'w-t1', task_id: 't1' })
    updateAgent(db, 'w-t1', { tmux_pane: '@10' })

    mockListWindows('@10 mc-w-t1\n')
    const killWindow = vi.fn()

    reapOrphanWindows(db, killWindow)

    expect(killWindow).toHaveBeenCalledWith('@10')
  })

  it('kills mc-* windows whose task is in failed state', () => {
    createTask(db, { id: 't1', title: 'T1' })
    updateTask(db, 't1', { status: 'failed' })
    registerAgent(db, { id: 'w-t1', task_id: 't1' })
    updateAgent(db, 'w-t1', { tmux_pane: '@11' })

    mockListWindows('@11 mc-w-t1\n')
    const killWindow = vi.fn()

    reapOrphanWindows(db, killWindow)

    expect(killWindow).toHaveBeenCalledWith('@11')
  })

  it('kills mc-* windows whose task is in cancelled state', () => {
    createTask(db, { id: 't1', title: 'T1' })
    updateTask(db, 't1', { status: 'cancelled' })
    registerAgent(db, { id: 'w-t1', task_id: 't1' })
    updateAgent(db, 'w-t1', { tmux_pane: '@12' })

    mockListWindows('@12 mc-w-t1\n')
    const killWindow = vi.fn()

    reapOrphanWindows(db, killWindow)

    expect(killWindow).toHaveBeenCalledWith('@12')
  })

  it('does NOT kill mc-* windows whose task is in_progress', () => {
    createTask(db, { id: 't1', title: 'T1' })
    updateTask(db, 't1', { status: 'in_progress' })
    registerAgent(db, { id: 'w-t1', task_id: 't1' })
    updateAgent(db, 'w-t1', { tmux_pane: '@13' })

    mockListWindows('@13 mc-w-t1\n')
    const killWindow = vi.fn()

    reapOrphanWindows(db, killWindow)

    expect(killWindow).not.toHaveBeenCalled()
  })

  it('does NOT kill mc-* windows whose task is pending', () => {
    createTask(db, { id: 't1', title: 'T1' })
    // status defaults to 'pending'
    registerAgent(db, { id: 'w-t1', task_id: 't1' })
    updateAgent(db, 'w-t1', { tmux_pane: '@14' })

    mockListWindows('@14 mc-w-t1\n')
    const killWindow = vi.fn()

    reapOrphanWindows(db, killWindow)

    expect(killWindow).not.toHaveBeenCalled()
  })

  it('kills mc-* windows with no matching agent record (fully orphaned)', () => {
    // No agent row for @15
    mockListWindows('@15 mc-w-ghost\n')
    const killWindow = vi.fn()

    reapOrphanWindows(db, killWindow)

    expect(killWindow).toHaveBeenCalledWith('@15')
  })

  it('kills mc-* windows whose agent has no task_id', () => {
    registerAgent(db, { id: 'w-no-task' }) // no task_id
    updateAgent(db, 'w-no-task', { tmux_pane: '@16' })

    mockListWindows('@16 mc-w-no-task\n')
    const killWindow = vi.fn()

    reapOrphanWindows(db, killWindow)

    expect(killWindow).toHaveBeenCalledWith('@16')
  })

  it('never kills windows that do not match the mc- prefix', () => {
    mockListWindows('@1 bash\n@2 zsh\n@3 my-window\n')
    const killWindow = vi.fn()

    reapOrphanWindows(db, killWindow)

    expect(killWindow).not.toHaveBeenCalled()
  })

  it('leaves non-MultiClaude windows untouched even when mc-* windows are reaped', () => {
    createTask(db, { id: 't1', title: 'T1' })
    updateTask(db, 't1', { status: 'done' })
    registerAgent(db, { id: 'w-t1', task_id: 't1' })
    updateAgent(db, 'w-t1', { tmux_pane: '@20' })

    // Mix of mc- and non-mc windows
    mockListWindows('@1 bash\n@2 my-project\n@20 mc-w-t1\n')
    const killWindow = vi.fn()

    reapOrphanWindows(db, killWindow)

    // Only the mc- window should be killed
    expect(killWindow).toHaveBeenCalledTimes(1)
    expect(killWindow).toHaveBeenCalledWith('@20')
  })

  it('reaps multiple orphan windows in one pass', () => {
    createTask(db, { id: 't1', title: 'T1' })
    updateTask(db, 't1', { status: 'done' })
    registerAgent(db, { id: 'w-t1', task_id: 't1' })
    updateAgent(db, 'w-t1', { tmux_pane: '@30' })

    createTask(db, { id: 't2', title: 'T2' })
    updateTask(db, 't2', { status: 'failed' })
    registerAgent(db, { id: 'w-t2', task_id: 't2' })
    updateAgent(db, 'w-t2', { tmux_pane: '@31' })

    // Plus a fully orphaned window with no agent record
    mockListWindows('@30 mc-w-t1\n@31 mc-w-t2\n@32 mc-w-ghost\n')
    const killWindow = vi.fn()

    reapOrphanWindows(db, killWindow)

    expect(killWindow).toHaveBeenCalledTimes(3)
    expect(killWindow).toHaveBeenCalledWith('@30')
    expect(killWindow).toHaveBeenCalledWith('@31')
    expect(killWindow).toHaveBeenCalledWith('@32')
  })

  it('skips live tasks while reaping dead ones in the same pass', () => {
    createTask(db, { id: 'live', title: 'Live' })
    updateTask(db, 'live', { status: 'in_progress' })
    registerAgent(db, { id: 'w-live', task_id: 'live' })
    updateAgent(db, 'w-live', { tmux_pane: '@40' })

    createTask(db, { id: 'dead', title: 'Dead' })
    updateTask(db, 'dead', { status: 'done' })
    registerAgent(db, { id: 'w-dead', task_id: 'dead' })
    updateAgent(db, 'w-dead', { tmux_pane: '@41' })

    mockListWindows('@40 mc-w-live\n@41 mc-w-dead\n')
    const killWindow = vi.fn()

    reapOrphanWindows(db, killWindow)

    expect(killWindow).toHaveBeenCalledTimes(1)
    expect(killWindow).toHaveBeenCalledWith('@41')
    expect(killWindow).not.toHaveBeenCalledWith('@40')
  })

  it('is a no-op when tmux is unavailable (ensureTmuxSession throws)', () => {
    delete process.env.TMUX
    mockExecSync.mockImplementationOnce(() => { throw new Error('no tmux') }) // has-session fails
    // new-session also fails (for non-tmux path, has-session throws means we try new-session)
    mockExecSync.mockImplementationOnce(() => { throw new Error('no tmux') })

    const killWindow = vi.fn()
    expect(() => reapOrphanWindows(db, killWindow)).not.toThrow()
    expect(killWindow).not.toHaveBeenCalled()
  })
})
