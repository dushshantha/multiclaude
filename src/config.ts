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
    return JSON.parse(readFileSync(configPath, 'utf-8')) as MultiClaudeConfig
  } catch {
    return null
  }
}

export function writeConfig(projectDir: string, config: MultiClaudeConfig): void {
  const configPath = join(projectDir, CONFIG_FILENAME)
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
}
