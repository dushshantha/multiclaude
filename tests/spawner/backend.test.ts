import { describe, it, expect } from 'vitest'
import { createBackend, ProcessBackend, CursorBackend } from '../../src/spawner/backend.js'
import type { RuntimeBackend, WorkerHandle } from '../../src/spawner/backend.js'

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

  it('throws for tmux runtime (not yet implemented)', () => {
    expect(() => createBackend('tmux')).toThrow(/not yet implemented/i)
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

  it('pid can be undefined (spawn failure)', () => {
    const handle: WorkerHandle = {
      pid: undefined,
      onExit: () => {},
      onError: () => {},
    }
    expect(handle.pid).toBeUndefined()
  })
})
