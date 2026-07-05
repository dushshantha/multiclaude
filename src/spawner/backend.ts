import type { SpawnConfig } from './index.js'
import { spawnWorker } from './index.js'
import { spawnCursorWorker } from './cursor.js'
import { spawnTmuxWorker } from './tmux.js'
import type { WorkerRuntime } from '../config.js'

export interface WorkerHandle {
  pid: number | undefined
  onExit(callback: () => void): void
  onError(callback: (err: Error) => void): void
}

export interface RuntimeBackend {
  launch(cfg: SpawnConfig): WorkerHandle
}

export class ProcessBackend implements RuntimeBackend {
  launch(cfg: SpawnConfig): WorkerHandle {
    const child = spawnWorker(cfg)
    return {
      pid: child.pid,
      onExit(cb) { child.on('exit', cb) },
      onError(cb) { child.on('error', cb) },
    }
  }
}

export class CursorBackend implements RuntimeBackend {
  private serverPort: number

  constructor(opts: { serverPort: number }) {
    this.serverPort = opts.serverPort
  }

  launch(cfg: SpawnConfig): WorkerHandle {
    const ptyProcess = spawnCursorWorker({ ...cfg, serverPort: this.serverPort })
    return {
      pid: ptyProcess.pid,
      onExit(cb) { ptyProcess.onExit(cb) },
      onError(_cb) { /* PTY spawn throws synchronously; no async error event */ },
    }
  }
}

export class TmuxBackend implements RuntimeBackend {
  launch(cfg: SpawnConfig): WorkerHandle {
    return spawnTmuxWorker(cfg)
  }
}

export interface BackendOptions {
  serverPort?: number
}

export function createBackend(runtime: WorkerRuntime, opts: BackendOptions = {}): RuntimeBackend {
  switch (runtime) {
    case 'claude':
      return new ProcessBackend()
    case 'cursor':
      if (opts.serverPort === undefined) {
        throw new Error('CursorBackend requires serverPort in options')
      }
      return new CursorBackend({ serverPort: opts.serverPort })
    case 'tmux':
      return new TmuxBackend()
    default: {
      const _exhaustive: never = runtime
      throw new Error(`Unknown runtime: ${_exhaustive}`)
    }
  }
}
