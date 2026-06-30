import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readConfig, writeConfig, isValidWorkerRuntime, type WorkerRuntime } from '../src/config.js'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `mc-config-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('config.ts', () => {
  describe('readConfig', () => {
    it('returns null when .multiclaude.json does not exist', () => {
      expect(readConfig(testDir)).toBeNull()
    })

    it('reads valid .multiclaude.json with workerRuntime: subprocess', () => {
      writeFileSync(join(testDir, '.multiclaude.json'), JSON.stringify({
        workerRuntime: 'subprocess'
      }))

      const config = readConfig(testDir)
      expect(config).toEqual({ workerRuntime: 'subprocess' })
    })

    it('reads valid .multiclaude.json with workerRuntime: tmux', () => {
      writeFileSync(join(testDir, '.multiclaude.json'), JSON.stringify({
        workerRuntime: 'tmux'
      }))

      const config = readConfig(testDir)
      expect(config).toEqual({ workerRuntime: 'tmux' })
    })

    it('reads config with stuckWarningMinutes and stuckTimeoutMinutes', () => {
      writeFileSync(join(testDir, '.multiclaude.json'), JSON.stringify({
        workerRuntime: 'subprocess',
        stuckWarningMinutes: 2,
        stuckTimeoutMinutes: 5
      }))

      const config = readConfig(testDir)
      expect(config?.stuckWarningMinutes).toBe(2)
      expect(config?.stuckTimeoutMinutes).toBe(5)
    })

    it('returns null on malformed JSON', () => {
      writeFileSync(join(testDir, '.multiclaude.json'), 'invalid json {')

      expect(readConfig(testDir)).toBeNull()
    })
  })

  describe('writeConfig', () => {
    it('writes config with workerRuntime: subprocess', () => {
      writeConfig(testDir, { workerRuntime: 'subprocess' })

      const content = readFileSync(join(testDir, '.multiclaude.json'), 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed.workerRuntime).toBe('subprocess')
    })

    it('writes config with workerRuntime: tmux', () => {
      writeConfig(testDir, { workerRuntime: 'tmux' })

      const content = readFileSync(join(testDir, '.multiclaude.json'), 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed.workerRuntime).toBe('tmux')
    })

    it('preserves stuckWarningMinutes and stuckTimeoutMinutes when writing', () => {
      writeConfig(testDir, {
        workerRuntime: 'tmux',
        stuckWarningMinutes: 3,
        stuckTimeoutMinutes: 7
      })

      const content = readFileSync(join(testDir, '.multiclaude.json'), 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed.stuckWarningMinutes).toBe(3)
      expect(parsed.stuckTimeoutMinutes).toBe(7)
    })

    it('formats output as pretty-printed JSON with newline at end', () => {
      writeConfig(testDir, { workerRuntime: 'subprocess' })

      const content = readFileSync(join(testDir, '.multiclaude.json'), 'utf-8')
      expect(content).toContain('\n')
      expect(content.endsWith('\n')).toBe(true)
      expect(content).toContain('  ')
    })
  })

  describe('isValidWorkerRuntime', () => {
    it('returns true for subprocess', () => {
      expect(isValidWorkerRuntime('subprocess')).toBe(true)
    })

    it('returns true for tmux', () => {
      expect(isValidWorkerRuntime('tmux')).toBe(true)
    })

    it('returns false for invalid values', () => {
      expect(isValidWorkerRuntime('invalid')).toBe(false)
      expect(isValidWorkerRuntime('claude')).toBe(false)
      expect(isValidWorkerRuntime('cursor')).toBe(false)
      expect(isValidWorkerRuntime('')).toBe(false)
    })

    it('returns false for non-string values', () => {
      expect(isValidWorkerRuntime(null)).toBe(false)
      expect(isValidWorkerRuntime(undefined)).toBe(false)
      expect(isValidWorkerRuntime(123)).toBe(false)
    })
  })
})
