import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { readConfig, writeConfig } from '../src/config.js'
import type { MultiClaudeConfig, WorkerRuntime } from '../src/config.js'

describe('config', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join('/tmp', 'mc-config-test-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('readConfig returns null when .multiclaude.json does not exist', () => {
    const config = readConfig(projectDir)
    expect(config).toBeNull()
  })

  it('writeConfig creates .multiclaude.json with valid config', () => {
    const cfg: MultiClaudeConfig = {
      workerRuntime: 'subprocess',
    }
    writeConfig(projectDir, cfg)

    const content = readFileSync(join(projectDir, '.multiclaude.json'), 'utf-8')
    const parsed = JSON.parse(content)
    expect(parsed.workerRuntime).toBe('subprocess')
  })

  it('readConfig parses .multiclaude.json and returns config', () => {
    const cfg: MultiClaudeConfig = {
      workerRuntime: 'subprocess',
      stuckWarningMinutes: 5,
      stuckTimeoutMinutes: 10,
    }
    writeConfig(projectDir, cfg)

    const read = readConfig(projectDir)
    expect(read).toEqual(cfg)
  })

  it('readConfig returns null on malformed JSON', () => {
    writeFileSync(join(projectDir, '.multiclaude.json'), 'invalid json {')
    const config = readConfig(projectDir)
    expect(config).toBeNull()
  })

  it('supports workerRuntime: subprocess', () => {
    const cfg: MultiClaudeConfig = { workerRuntime: 'subprocess' }
    writeConfig(projectDir, cfg)
    const read = readConfig(projectDir)
    expect(read?.workerRuntime).toBe('subprocess')
  })

  it('supports workerRuntime: tmux', () => {
    const cfg: MultiClaudeConfig = { workerRuntime: 'tmux' }
    writeConfig(projectDir, cfg)
    const read = readConfig(projectDir)
    expect(read?.workerRuntime).toBe('tmux')
  })

  it('stores stuckWarningMinutes and stuckTimeoutMinutes', () => {
    const cfg: MultiClaudeConfig = {
      workerRuntime: 'subprocess',
      stuckWarningMinutes: 15,
      stuckTimeoutMinutes: 60,
    }
    writeConfig(projectDir, cfg)
    const read = readConfig(projectDir)
    expect(read?.stuckWarningMinutes).toBe(15)
    expect(read?.stuckTimeoutMinutes).toBe(60)
  })

  it('writeConfig produces valid JSON with proper formatting', () => {
    const cfg: MultiClaudeConfig = {
      workerRuntime: 'tmux',
      stuckWarningMinutes: 10,
    }
    writeConfig(projectDir, cfg)

    const content = readFileSync(join(projectDir, '.multiclaude.json'), 'utf-8')
    // Should have proper indentation and trailing newline
    expect(content).toMatch(/\n$/)
    expect(content).toContain('  "workerRuntime": "tmux"')
  })
})
