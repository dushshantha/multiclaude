import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runInit, MULTICLAUDE_PERMISSIONS } from '../src/init.js'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `mc-init-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('runInit', () => {
  it('creates .claude/settings.local.json with permissions', () => {
    runInit({ projectDir: testDir })

    const settingsPath = join(testDir, '.claude', 'settings.local.json')
    expect(existsSync(settingsPath)).toBe(true)

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(settings.permissions?.allow).toContain('mcp__multiclaude-coord__plan_dag')
  })

  it('does not write mcpServers to settings.local.json (handled globally by start)', () => {
    runInit({ projectDir: testDir })
    const settings = JSON.parse(
      readFileSync(join(testDir, '.claude', 'settings.local.json'), 'utf-8')
    )
    expect(settings.mcpServers).toBeUndefined()
  })

  it('merges with existing settings without overwriting unrelated keys', () => {
    const claudeDir = join(testDir, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify({
      permissions: { allow: ['Bash(git:*)'] },
      someOtherKey: 'preserved',
    }))

    runInit({ projectDir: testDir })

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'))
    expect(settings.someOtherKey).toBe('preserved')
    expect(settings.permissions.allow).toContain('Bash(git:*)')
    expect(settings.permissions.allow).toContain('mcp__multiclaude-coord__plan_dag')
  })

  it('does not duplicate permissions when run twice', () => {
    runInit({ projectDir: testDir })
    runInit({ projectDir: testDir })

    const settings = JSON.parse(readFileSync(join(testDir, '.claude', 'settings.local.json'), 'utf-8'))
    const planDagCount = settings.permissions.allow.filter(
      (p: string) => p === 'mcp__multiclaude-coord__plan_dag'
    ).length
    expect(planDagCount).toBe(1)
  })

  it('creates CLAUDE.md with multiclaude section when file does not exist', () => {
    runInit({ projectDir: testDir })

    const claudeMd = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain('<!-- multiclaude:start -->')
    expect(claudeMd).toContain('<!-- multiclaude:end -->')
    expect(claudeMd).toContain('MultiClaude Orchestrator')
  })

  it('appends multiclaude section to existing CLAUDE.md', () => {
    writeFileSync(join(testDir, 'CLAUDE.md'), '# My Project\n\nExisting content.\n')

    runInit({ projectDir: testDir })

    const claudeMd = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain('# My Project')
    expect(claudeMd).toContain('Existing content.')
    expect(claudeMd).toContain('<!-- multiclaude:start -->')
  })

  it('replaces existing multiclaude section on re-run (idempotent)', () => {
    runInit({ projectDir: testDir })
    runInit({ projectDir: testDir })

    const claudeMd = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8')
    const startCount = (claudeMd.match(/<!-- multiclaude:start -->/g) ?? []).length
    expect(startCount).toBe(1)
  })

  it('removes stale mcpServers from existing settings', () => {
    const claudeDir = join(testDir, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify({
      permissions: { allow: [] },
      mcpServers: { 'multiclaude-coord': { type: 'http', url: 'http://localhost:7432/orchestrator' } },
    }))

    runInit({ projectDir: testDir })

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'))
    expect(settings.mcpServers).toBeUndefined()
  })
})

describe('MULTICLAUDE_PERMISSIONS', () => {
  it('includes the core orchestrator tools under multiclaude-coord', () => {
    expect(MULTICLAUDE_PERMISSIONS).toContain('mcp__multiclaude-coord__plan_dag')
    expect(MULTICLAUDE_PERMISSIONS).toContain('mcp__multiclaude-coord__spawn_worker')
    expect(MULTICLAUDE_PERMISSIONS).toContain('mcp__multiclaude-coord__get_system_status')
  })

  it('includes worker tools under multiclaude-worker (separate from orchestrator)', () => {
    expect(MULTICLAUDE_PERMISSIONS).toContain('mcp__multiclaude-worker__get_my_task')
    expect(MULTICLAUDE_PERMISSIONS).toContain('mcp__multiclaude-worker__report_done')
    expect(MULTICLAUDE_PERMISSIONS).toContain('mcp__multiclaude-worker__report_progress')
    // Worker tools must NOT be listed under multiclaude-coord
    expect(MULTICLAUDE_PERMISSIONS).not.toContain('mcp__multiclaude-coord__get_my_task')
    expect(MULTICLAUDE_PERMISSIONS).not.toContain('mcp__multiclaude-coord__report_done')
  })
})
