import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

export type WorkerRuntime = 'subprocess' | 'tmux'

export interface MultiClaudeConfig {
  workerRuntime: WorkerRuntime
  stuckWarningMinutes?: number
  stuckTimeoutMinutes?: number
}

const CONFIG_FILENAME = '.multiclaude.json'
const VALID_WORKER_RUNTIMES: readonly WorkerRuntime[] = ['subprocess', 'tmux']

export function isValidWorkerRuntime(value: unknown): value is WorkerRuntime {
  return typeof value === 'string' && VALID_WORKER_RUNTIMES.includes(value as WorkerRuntime)
}

export function readConfig(projectDir: string): MultiClaudeConfig | null {
  const configPath = join(projectDir, CONFIG_FILENAME)
  if (!existsSync(configPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const config = parsed as Record<string, unknown>
      if (!isValidWorkerRuntime(config.workerRuntime)) {
        return null
      }
      return {
        workerRuntime: config.workerRuntime,
        stuckWarningMinutes: typeof config.stuckWarningMinutes === 'number' ? config.stuckWarningMinutes : undefined,
        stuckTimeoutMinutes: typeof config.stuckTimeoutMinutes === 'number' ? config.stuckTimeoutMinutes : undefined,
      }
    }
    return null
  } catch {
    return null
  }
}

export function writeConfig(projectDir: string, config: MultiClaudeConfig): void {
  if (!isValidWorkerRuntime(config.workerRuntime)) {
    throw new Error(`Invalid workerRuntime: ${config.workerRuntime}. Must be one of: ${VALID_WORKER_RUNTIMES.join(', ')}`)
  }
  const configPath = join(projectDir, CONFIG_FILENAME)
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
}
