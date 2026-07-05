import { describe, it, expect, vi } from 'vitest'
import { createBackend, ProcessBackend, CursorBackend, TmuxBackend } from '../../src/spawner/backend.js'
import type { RuntimeBackend, WorkerHandle } from '../../src/spawner/backend.js'

// TmuxBackend calls into child_process and fs at construction/launch time;
// mock them so the import doesn't fail in CI where tmux is not installed.
vi.mock('../../src/spawner/tmux.js', () => ({
  spawnTmuxWorker: vi.fn(() => ({
    pid: undefined,
    tmuxPane: 'multiclaude:mc-task-1',
    onExit: vi.fn(),
    onError: vi.fn(),
  })),
  captureTmuxPane: vi.fn(() => ''),
}))

describe('RuntimeBackend interface', () => {
  it('ProcessBackend implements RuntimeBackend', () => {
    const backend: RuntimeBackend = new ProcessBackend()
    expect(backend).toBeInstanceOf(ProcessBackend)
    expect(typeof backend.launch).toBe('function')
  })

  it('CursorBackend implements RuntimeBackend', () => {
    const backend: RuntimeBackend = new CursorBackend({ serverPort: 7432 })
    expect(backend).toBeInstanceOf(CursorBackend)
    expect(typeof backend.launch).toBe('function')
  })

  it('TmuxBackend implements RuntimeBackend', () => {
    const backend: RuntimeBackend = new TmuxBackend()
    expect(backend).toBeInstanceOf(TmuxBackend)
    expect(typeof backend.launch).toBe('function')
  })
})

describe('createBackend', () => {
  it('returns ProcessBackend for claude runtime', () => {
    const backend = createBackend('claude')
    expect(backend).toBeInstanceOf(ProcessBackend)
  })

  it('returns CursorBackend for cursor runtime', () => {
    const backend = createBackend('cursor', { serverPort: 7432 })
    expect(backend).toBeInstanceOf(CursorBackend)
  })

  it('returns TmuxBackend for tmux runtime', () => {
    const backend = createBackend('tmux')
    expect(backend).toBeInstanceOf(TmuxBackend)
  })

  it('throws for cursor runtime without serverPort', () => {
    expect(() => createBackend('cursor')).toThrow(/serverPort/)
  })
})

describe('WorkerHandle shape', () => {
  it('has the expected interface members', () => {
    const handle: WorkerHandle = {
      pid: 123,
      onExit: (_cb: () => void) => {},
      onError: (_cb: (err: Error) => void) => {},
    }
    expect(handle.pid).toBe(123)
    expect(typeof handle.onExit).toBe('function')
    expect(typeof handle.onError).toBe('function')
  })

  it('tmuxPane is optional and carries the window target', () => {
    const handle: WorkerHandle = {
      pid: undefined,
      tmuxPane: 'multiclaude:mc-my-task',
      onExit: () => {},
      onError: () => {},
    }
    expect(handle.tmuxPane).toBe('multiclaude:mc-my-task')
  })

  it('pid can be undefined (spawn failure)', () => {
    const handle: WorkerHandle = {
      pid: undefined,
      onExit: () => {},
      onError: () => {},
    }
    expect(handle.pid).toBeUndefined()
  })
})
