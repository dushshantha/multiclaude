import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readConfig, writeConfig } from '../src/config.js'
import type { WorkerRuntime } from '../src/config.js'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `mc-config-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('WorkerRuntime', () => {
  it('accepts claude as a valid runtime', () => {
    const runtime: WorkerRuntime = 'claude'
    writeConfig(testDir, { workerRuntime: runtime })
    const config = readConfig(testDir)
    expect(config?.workerRuntime).toBe('claude')
  })

  it('accepts cursor as a valid runtime', () => {
    const runtime: WorkerRuntime = 'cursor'
    writeConfig(testDir, { workerRuntime: runtime })
    const config = readConfig(testDir)
    expect(config?.workerRuntime).toBe('cursor')
  })

  it('accepts tmux as a valid runtime', () => {
    const runtime: WorkerRuntime = 'tmux'
    writeConfig(testDir, { workerRuntime: runtime })
    const config = readConfig(testDir)
    expect(config?.workerRuntime).toBe('tmux')
  })
})

describe('readConfig', () => {
  it('returns null when .multiclaude.json does not exist', () => {
    expect(readConfig(testDir)).toBeNull()
  })

  it('reads valid config', () => {
    writeFileSync(
      join(testDir, '.multiclaude.json'),
      JSON.stringify({ workerRuntime: 'claude' })
    )
    const config = readConfig(testDir)
    expect(config).toEqual({ workerRuntime: 'claude' })
  })

  it('returns null for malformed JSON', () => {
    writeFileSync(join(testDir, '.multiclaude.json'), 'not json')
    expect(readConfig(testDir)).toBeNull()
  })
})

describe('writeConfig', () => {
  it('writes .multiclaude.json with proper formatting', () => {
    writeConfig(testDir, { workerRuntime: 'tmux' })
    const raw = readFileSync(join(testDir, '.multiclaude.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.workerRuntime).toBe('tmux')
    expect(raw.endsWith('\n')).toBe(true)
  })
})
