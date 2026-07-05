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

  it('calls tmux new-window with correct session, name and cwd', () => {
    mockExecSync.mockReturnValueOnce(undefined)
    const target = createTmuxWindow('my-session', 'task-1', '/tmp/worktree')
    expect(target).toBe('my-session:mc-task-1')
    const call = mockExecSync.mock.calls[0][0] as string
    expect(call).toContain('new-window')
    expect(call).toContain('-d')
    expect(call).toContain('mc-task-1')
    expect(call).toContain('/tmp/worktree')
  })

  it('uses mc- prefix for window name', () => {
    mockExecSync.mockReturnValueOnce(undefined)
    const target = createTmuxWindow('sess', 'my-task', '/path')
    expect(target).toContain('mc-my-task')
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
