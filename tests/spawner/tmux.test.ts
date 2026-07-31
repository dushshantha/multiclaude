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
  ensureTmuxSession,
  createTmuxWindow,
  getTmuxPanePid,
  sendTmuxKeys,
  writeLaunchScript,
  captureTmuxPane,
  spawnTmuxWorker,
  killTmuxWindow,
} from '../../src/spawner/tmux.js'

describe('ensureTmuxSession', () => {
  const origTmux = process.env.TMUX

  beforeEach(() => {
    mockExecSync.mockReset()
  })

  afterEach(() => {
    if (origTmux === undefined) delete process.env.TMUX
    else process.env.TMUX = origTmux
  })

  it('returns current session name when inside tmux', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0'
    mockExecSync.mockReturnValueOnce('my-session\n')
    const result = ensureTmuxSession()
    expect(result).toBe('my-session')
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('display-message'),
      expect.objectContaining({ encoding: 'utf8' })
    )
  })

  it('reuses existing multiclaude session when not in tmux', () => {
    delete process.env.TMUX
    // has-session succeeds (session exists)
    mockExecSync.mockReturnValueOnce(undefined)
    const result = ensureTmuxSession()
    expect(result).toBe('multiclaude')
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('has-session'),
      expect.anything()
    )
    // new-session should NOT be called
    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    expect(calls.some(c => c.includes('new-session'))).toBe(false)
  })

  it('creates a new multiclaude session when not in tmux and none exists', () => {
    delete process.env.TMUX
    // has-session throws (session does not exist)
    mockExecSync.mockImplementationOnce(() => { throw new Error('no server running') })
    // new-session succeeds
    mockExecSync.mockReturnValueOnce(undefined)
    const result = ensureTmuxSession()
    expect(result).toBe('multiclaude')
    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    expect(calls.some(c => c.includes('new-session'))).toBe(true)
    expect(calls.some(c => c.includes('-d'))).toBe(true)
  })
})

describe('createTmuxWindow', () => {
  beforeEach(() => {
    mockExecSync.mockReset()
  })

  it('calls tmux new-window with -P -F #{window_id} and returns @NN ID', () => {
    mockExecSync.mockReturnValueOnce('@42\n')
    const windowId = createTmuxWindow('my-session', 'mc-w-task-1', '/tmp/worktree')
    expect(windowId).toBe('@42')
    const call = mockExecSync.mock.calls[0][0] as string
    expect(call).toContain('new-window')
    expect(call).toContain('-P')
    expect(call).toContain('#{window_id}')
    expect(call).toContain('mc-w-task-1')
    expect(call).toContain('/tmp/worktree')
  })

  it('passes the exact windowName to tmux (caller controls the name)', () => {
    mockExecSync.mockReturnValueOnce('@7\n')
    const windowId = createTmuxWindow('sess', 'mc-w-my-task-retry1', '/path')
    expect(windowId).toBe('@7')
    const call = mockExecSync.mock.calls[0][0] as string
    expect(call).toContain('mc-w-my-task-retry1')
  })

  it('throws when tmux returns an empty window ID', () => {
    mockExecSync.mockReturnValueOnce('\n')
    expect(() => createTmuxWindow('sess', 'mc-w-task', '/path')).toThrow(/tmux_window_create_failed/)
  })
})

describe('killTmuxWindow', () => {
  beforeEach(() => {
    mockExecSync.mockReset()
  })

  it('calls tmux kill-window with the given window ID', () => {
    mockExecSync.mockReturnValueOnce(undefined)
    killTmuxWindow('@42')
    const call = mockExecSync.mock.calls[0][0] as string
    expect(call).toContain('kill-window')
    expect(call).toContain('@42')
  })

  it('silently ignores errors when window is already dead', () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('no such window') })
    expect(() => killTmuxWindow('@42')).not.toThrow()
  })
})

describe('getTmuxPanePid', () => {
  beforeEach(() => {
    mockExecSync.mockReset()
  })

  it('returns parsed integer PID from tmux output', () => {
    mockExecSync.mockReturnValueOnce('12345\n')
    const pid = getTmuxPanePid('session:window')
    expect(pid).toBe(12345)
  })

  it('returns undefined when execSync throws', () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('tmux error') })
    const pid = getTmuxPanePid('session:window')
    expect(pid).toBeUndefined()
  })

  it('returns undefined for non-numeric output', () => {
    mockExecSync.mockReturnValueOnce('not-a-number\n')
    const pid = getTmuxPanePid('session:window')
    expect(pid).toBeUndefined()
  })
})

describe('sendTmuxKeys', () => {
  beforeEach(() => {
    mockExecSync.mockReset()
  })

  it('calls tmux send-keys with target and command', () => {
    sendTmuxKeys('session:mc-task', 'echo hello')
    const call = mockExecSync.mock.calls[0][0] as string
    expect(call).toContain('send-keys')
    expect(call).toContain('session:mc-task')
    expect(call).toContain('echo hello')
    expect(call).toContain('Enter')
  })

  it('passes -t flag to target the correct pane', () => {
    sendTmuxKeys('mysess:mywin', 'ls')
    const call = mockExecSync.mock.calls[0][0] as string
    expect(call).toContain('-t')
  })
})

describe('captureTmuxPane', () => {
  beforeEach(() => {
    mockExecSync.mockReset()
  })

  it('runs capture-pane with the specified target', () => {
    mockExecSync.mockReturnValueOnce('line1\nline2\n')
    const result = captureTmuxPane('session:mc-task')
    expect(result).toBe('line1\nline2\n')
    const call = mockExecSync.mock.calls[0][0] as string
    expect(call).toContain('capture-pane')
    expect(call).toContain('-p')
    expect(call).toContain('session:mc-task')
  })

  it('uses default of 40 lines when none specified', () => {
    mockExecSync.mockReturnValueOnce('')
    captureTmuxPane('sess:win')
    const call = mockExecSync.mock.calls[0][0] as string
    expect(call).toContain('-S -40')
  })

  it('uses the specified line count', () => {
    mockExecSync.mockReturnValueOnce('')
    captureTmuxPane('sess:win', 100)
    const call = mockExecSync.mock.calls[0][0] as string
    expect(call).toContain('-S -100')
  })

  it('returns empty string when tmux throws', () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('no tmux') })
    const result = captureTmuxPane('bad:target')
    expect(result).toBe('')
  })

  it('shell-quotes target to handle special chars', () => {
    mockExecSync.mockReturnValueOnce('')
    captureTmuxPane("session:it's-special")
    const call = mockExecSync.mock.calls[0][0] as string
    // target should be quoted
    expect(call).toContain("'session:it'\\''s-special'")
  })
})

describe('writeLaunchScript', () => {
  beforeEach(() => {
    mockWriteFileSync.mockReset()
    mockMkdirSync.mockReset()
    mockExecSync.mockReset()
  })

  it('writes an executable shell script to .claude/worker-launch.sh', () => {
    const cfg = {
      taskId: 'task-1',
      taskTitle: 'Build something',
      agentId: 'w-task-1',
      worktreePath: '/tmp/worktree',
      mcpConfigPath: '/tmp/mcp.json',
    }
    const scriptPath = writeLaunchScript(cfg)
    expect(scriptPath).toContain('worker-launch.sh')
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('worker-launch.sh'),
      expect.stringContaining('#!/usr/bin/env bash'),
      expect.objectContaining({ mode: 0o755 })
    )
  })

  it('includes exec claude in the script', () => {
    const cfg = {
      taskId: 'task-1',
      taskTitle: 'Build something',
      agentId: 'w-task-1',
      worktreePath: '/tmp/worktree',
      mcpConfigPath: '/tmp/mcp.json',
    }
    writeLaunchScript(cfg)
    const scriptContent = mockWriteFileSync.mock.calls[0][1] as string
    expect(scriptContent).toContain('exec claude')
  })

  it('sets MULTICLAUDE_AGENT_ID in the script', () => {
    const cfg = {
      taskId: 'task-2',
      taskTitle: 'Another task',
      agentId: 'w-task-2',
      worktreePath: '/tmp/wt2',
      mcpConfigPath: '/tmp/mcp.json',
    }
    writeLaunchScript(cfg)
    const scriptContent = mockWriteFileSync.mock.calls[0][1] as string
    expect(scriptContent).toContain('MULTICLAUDE_AGENT_ID')
    expect(scriptContent).toContain('w-task-2')
  })
})

describe('spawnTmuxWorker', () => {
  const cfg = {
    taskId: 'task-42',
    taskTitle: 'Build the thing',
    agentId: 'w-task-42',
    worktreePath: '/tmp/wt-42',
    mcpConfigPath: '/tmp/mcp.json',
  }

  // Helper: sets up the standard 6-call mock sequence (not-in-tmux path)
  // 1. has-session (ensureTmuxSession)
  // 2. list-windows (reapStaleWindows → listTmuxWindows → returns empty)
  // 3. new-window -P -F #{window_id} (createTmuxWindow → returns windowId)
  // 4. display-message '' (windowExists → succeeds)
  // 5. display-message pane_pid (getTmuxPanePid)
  // 6. send-keys (sendTmuxKeys)
  function setupDefaultMocks({ windowId = '@42', pid = '9999\n' } = {}) {
    mockExecSync.mockReset()
    mockExecSync.mockReturnValueOnce(undefined)       // has-session succeeds
    mockExecSync.mockReturnValueOnce('')              // list-windows (reapStaleWindows) → empty
    mockExecSync.mockReturnValueOnce(`${windowId}\n`) // new-window returns @NN
    mockExecSync.mockReturnValueOnce(undefined)       // windowExists succeeds
    mockExecSync.mockReturnValueOnce(pid)             // pane PID
    mockExecSync.mockReturnValueOnce(undefined)       // send-keys
  }

  beforeEach(() => {
    mockExecSync.mockReset()
    mockSpawn.mockReset()
    mockWriteFileSync.mockReset()
    mockMkdirSync.mockReset()
    setupDefaultMocks()
    mockSpawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() })
    delete process.env.TMUX
  })

  afterEach(() => {
    delete process.env.TMUX
  })

  it('returns a WorkerHandle with tmuxPane set to the @NN window ID', () => {
    setupDefaultMocks({ windowId: '@42' })
    const handle = spawnTmuxWorker(cfg)
    expect(handle.tmuxPane).toBe('@42')
  })

  it('uses a unique window name per agent (mc-<agentId>)', () => {
    setupDefaultMocks()
    spawnTmuxWorker(cfg)
    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    const newWindowCall = calls.find(c => c.includes('new-window'))
    expect(newWindowCall).toBeDefined()
    // Window name should embed the agentId, not just the taskId
    expect(newWindowCall).toContain('mc-w-task-42')
  })

  it('different agentIds produce different window names', () => {
    const windowNames: string[] = []
    for (const agentId of ['w-task-1', 'w-task-1-retry1', 'w-task-1-retry2']) {
      mockExecSync.mockReset()
      mockExecSync.mockReturnValueOnce(undefined)    // has-session
      mockExecSync.mockReturnValueOnce('')           // list-windows (reapStaleWindows)
      mockExecSync.mockReturnValueOnce('@99\n')      // new-window
      mockExecSync.mockReturnValueOnce(undefined)    // windowExists
      mockExecSync.mockReturnValueOnce('1234\n')     // pane PID
      mockExecSync.mockReturnValueOnce(undefined)    // send-keys
      mockSpawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() })
      spawnTmuxWorker({ ...cfg, agentId })
      const calls = mockExecSync.mock.calls.map(c => c[0] as string)
      const newWindowCall = calls.find(c => c.includes('new-window'))!
      // Extract the -n 'mc-...' part
      const match = newWindowCall.match(/-n '([^']+)'/)
      windowNames.push(match?.[1] ?? '')
      mockExecSync.mockReset()
    }
    // All three window names must be unique
    expect(new Set(windowNames).size).toBe(3)
  })

  it('sets pid from getTmuxPanePid output', () => {
    setupDefaultMocks({ pid: '12345\n' })
    const handle = spawnTmuxWorker(cfg)
    expect(handle.pid).toBe(12345)
  })

  it('pid is undefined when getTmuxPanePid fails', () => {
    mockExecSync.mockReset()
    mockExecSync.mockReturnValueOnce(undefined)                              // has-session
    mockExecSync.mockReturnValueOnce('')                                     // list-windows (reapStaleWindows)
    mockExecSync.mockReturnValueOnce('@42\n')                                // new-window
    mockExecSync.mockReturnValueOnce(undefined)                              // windowExists
    mockExecSync.mockImplementationOnce(() => { throw new Error('nopid') }) // pane PID fails
    mockExecSync.mockReturnValueOnce(undefined)                              // send-keys

    const handle = spawnTmuxWorker(cfg)
    expect(handle.pid).toBeUndefined()
  })

  it('spawns a tmux wait-for monitor using the agentId in the signal name', () => {
    setupDefaultMocks()
    spawnTmuxWorker(cfg)
    expect(mockSpawn).toHaveBeenCalledWith(
      'tmux',
      ['wait-for', 'mc-w-task-42-exit'],
      expect.objectContaining({ stdio: 'ignore', detached: false })
    )
  })

  it('targets send-keys at the @NN window ID, not a name-based target', () => {
    setupDefaultMocks({ windowId: '@42' })
    spawnTmuxWorker(cfg)
    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    const sendKeysCall = calls.find(c => c.includes('send-keys') && c.includes('worker-launch.sh'))
    expect(sendKeysCall).toBeDefined()
    expect(sendKeysCall).toContain('@42')
    expect(sendKeysCall).toContain('Enter')
  })

  it('appends tmux wait-for signal to the send-keys command', () => {
    setupDefaultMocks()
    spawnTmuxWorker(cfg)
    const calls = mockExecSync.mock.calls.map(c => c[0] as string)
    const sendKeysCall = calls.find(c => c.includes('send-keys'))
    expect(sendKeysCall).toContain('wait-for -S')
    expect(sendKeysCall).toContain('mc-w-task-42-exit')
  })

  it('writes settings.local.json before spawning', () => {
    setupDefaultMocks()
    spawnTmuxWorker(cfg)
    const settingsCall = mockWriteFileSync.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes('settings.local.json')
    )
    expect(settingsCall).toBeDefined()
    const content = JSON.parse(settingsCall![1] as string)
    expect(content.permissions.allow).toContain('Bash(*)')
  })

  it('exposes onExit and onError via the monitor process events', () => {
    setupDefaultMocks()
    const onMock = vi.fn()
    mockSpawn.mockReturnValue({ on: onMock, unref: vi.fn() })

    const handle = spawnTmuxWorker(cfg)

    const exitCb = vi.fn()
    const errCb = vi.fn()
    handle.onExit(exitCb)
    handle.onError(errCb)

    expect(onMock).toHaveBeenCalledWith('exit', exitCb)
    expect(onMock).toHaveBeenCalledWith('error', errCb)
  })
})
