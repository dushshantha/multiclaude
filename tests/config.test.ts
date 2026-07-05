import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { readConfig, writeConfig, MultiClaudeConfig, WorkerRuntime, isValidWorkerRuntime } from '../src/config.js'

describe('config', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync('mc-test-')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true })
  })

  describe('WorkerRuntime type', () => {
    it('should accept subprocess as valid value', () => {
      const runtime: WorkerRuntime = 'subprocess'
      expect(runtime).toBe('subprocess')
    })

    it('should accept tmux as valid value', () => {
      const runtime: WorkerRuntime = 'tmux'
      expect(runtime).toBe('tmux')
    })
  })

  describe('readConfig', () => {
    it('returns null when config file does not exist', () => {
      const config = readConfig(tempDir)
      expect(config).toBeNull()
    })

    it('reads valid config with subprocess runtime', () => {
      const configPath = join(tempDir, '.multiclaude.json')
      writeFileSync(configPath, JSON.stringify({ workerRuntime: 'subprocess' }))

      const config = readConfig(tempDir)
      expect(config).toEqual({ workerRuntime: 'subprocess' })
    })

    it('reads valid config with tmux runtime', () => {
      const configPath = join(tempDir, '.multiclaude.json')
      writeFileSync(configPath, JSON.stringify({ workerRuntime: 'tmux' }))

      const config = readConfig(tempDir)
      expect(config).toEqual({ workerRuntime: 'tmux' })
    })

    it('reads config with optional stuck timeout fields', () => {
      const configPath = join(tempDir, '.multiclaude.json')
      const configData = {
        workerRuntime: 'subprocess',
        stuckWarningMinutes: 5,
        stuckTimeoutMinutes: 15,
      }
      writeFileSync(configPath, JSON.stringify(configData))

      const config = readConfig(tempDir)
      expect(config).toEqual(configData)
    })

    it('returns null on invalid JSON', () => {
      const configPath = join(tempDir, '.multiclaude.json')
      writeFileSync(configPath, 'invalid json {')

      const config = readConfig(tempDir)
      expect(config).toBeNull()
    })
  })

  describe('writeConfig', () => {
    it('writes config with subprocess runtime', () => {
      const config: MultiClaudeConfig = { workerRuntime: 'subprocess' }
      writeConfig(tempDir, config)

      const configPath = join(tempDir, '.multiclaude.json')
      const written = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(written).toEqual(config)
    })

    it('writes config with tmux runtime', () => {
      const config: MultiClaudeConfig = { workerRuntime: 'tmux' }
      writeConfig(tempDir, config)

      const configPath = join(tempDir, '.multiclaude.json')
      const written = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(written).toEqual(config)
    })

    it('writes config with all fields', () => {
      const config: MultiClaudeConfig = {
        workerRuntime: 'tmux',
        stuckWarningMinutes: 3,
        stuckTimeoutMinutes: 10,
      }
      writeConfig(tempDir, config)

      const configPath = join(tempDir, '.multiclaude.json')
      const written = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(written).toEqual(config)
    })

    it('formats output with 2-space indentation', () => {
      const config: MultiClaudeConfig = { workerRuntime: 'subprocess' }
      writeConfig(tempDir, config)

      const configPath = join(tempDir, '.multiclaude.json')
      const content = readFileSync(configPath, 'utf-8')
      // Check for 2-space indentation and trailing newline
      expect(content).toMatch(/\n  "workerRuntime"/)
      expect(content).toBe(content.trimEnd() + '\n')
    })
  })

  describe('roundtrip', () => {
    it('preserves config through write and read cycle', () => {
      const original: MultiClaudeConfig = {
        workerRuntime: 'tmux',
        stuckWarningMinutes: 4,
        stuckTimeoutMinutes: 12,
      }
      writeConfig(tempDir, original)
      const read = readConfig(tempDir)
      expect(read).toEqual(original)
    })
  })

  describe('isValidWorkerRuntime', () => {
    it('returns true for subprocess', () => {
      expect(isValidWorkerRuntime('subprocess')).toBe(true)
    })

    it('returns true for tmux', () => {
      expect(isValidWorkerRuntime('tmux')).toBe(true)
    })

    it('returns false for invalid string values', () => {
      expect(isValidWorkerRuntime('invalid')).toBe(false)
      expect(isValidWorkerRuntime('claude')).toBe(false)
      expect(isValidWorkerRuntime('cursor')).toBe(false)
    })

    it('returns false for non-string values', () => {
      expect(isValidWorkerRuntime(123)).toBe(false)
      expect(isValidWorkerRuntime(null)).toBe(false)
      expect(isValidWorkerRuntime(undefined)).toBe(false)
      expect(isValidWorkerRuntime({})).toBe(false)
    })
  })

  describe('validation on write', () => {
    it('throws error for invalid workerRuntime', () => {
      const config = { workerRuntime: 'invalid' } as any
      expect(() => writeConfig(tempDir, config)).toThrow(/Invalid workerRuntime/)
    })

    it('throws error for old claude/cursor values', () => {
      const config = { workerRuntime: 'claude' } as any
      expect(() => writeConfig(tempDir, config)).toThrow(/Invalid workerRuntime/)
    })
  })

  describe('validation on read', () => {
    it('returns null for invalid workerRuntime in file', () => {
      const configPath = join(tempDir, '.multiclaude.json')
      writeFileSync(configPath, JSON.stringify({ workerRuntime: 'invalid' }))

      const config = readConfig(tempDir)
      expect(config).toBeNull()
    })

    it('returns null for old claude/cursor values in file', () => {
      const configPath = join(tempDir, '.multiclaude.json')
      writeFileSync(configPath, JSON.stringify({ workerRuntime: 'claude' }))

      const config = readConfig(tempDir)
      expect(config).toBeNull()
    })
  })
})
