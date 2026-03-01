import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const MULTICLAUDE_PERMISSIONS = [
  // Orchestrator tools — accessed via user-level 'multiclaude-coord' MCP server
  'mcp__multiclaude-coord__get_system_status',
  'mcp__multiclaude-coord__wait_for_event',
  'mcp__multiclaude-coord__plan_dag',
  'mcp__multiclaude-coord__spawn_worker',
  'mcp__multiclaude-coord__cancel_task',
  'mcp__multiclaude-coord__complete_task',
  // Worker tools — accessed via 'multiclaude-worker' MCP server (injected via --mcp-config)
  'mcp__multiclaude-worker__get_my_task',
  'mcp__multiclaude-worker__report_progress',
  'mcp__multiclaude-worker__report_done',
  'mcp__multiclaude-worker__report_blocked',
  'Bash(npm install:*)',
  'Bash(npm test:*)',
  'Bash(npm start:*)',
  'Bash(node:*)',
  'Bash(curl:*)',
  'Bash(lsof:*)',
]

export interface InitOptions {
  projectDir?: string
}

export function runInit(opts: InitOptions = {}): void {
  const projectDir = resolve(opts.projectDir ?? process.cwd())

  updateSettings(projectDir)
  updateClaudeMd(projectDir)

  console.log(`✓ MultiClaude initialized in ${projectDir}`)
  console.log(`  .claude/settings.local.json — permissions added`)
  console.log(`  CLAUDE.md — orchestrator instructions added`)
  console.log(`\nMake sure MultiClaude is running: multiclaude start`)
  console.log(`Then just run:                    claude   (from this directory)`)
}

function updateSettings(projectDir: string): void {
  const claudeDir = join(projectDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })

  const settingsPath = join(claudeDir, 'settings.local.json')
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch {
      // malformed JSON — start fresh
    }
  }

  // Remove any stale mcpServers — MCP registration is handled globally by
  // 'multiclaude start' (written to ~/.claude.json via 'claude mcp add').
  // Having it here too causes naming conflicts with worker --mcp-config.
  delete settings.mcpServers

  // Merge permissions.allow (deduplicated)
  const permissions = (settings.permissions as { allow?: string[] } | undefined) ?? {}
  const existing = permissions.allow ?? []
  const merged = Array.from(new Set([...existing, ...MULTICLAUDE_PERMISSIONS]))
  settings.permissions = { ...permissions, allow: merged }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

function updateClaudeMd(projectDir: string): void {
  const claudeMdPath = join(projectDir, 'CLAUDE.md')
  const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf-8') : ''

  const orchestratorContent = loadOrchestratorContent()
  const section = `<!-- multiclaude:start -->\n${orchestratorContent}\n<!-- multiclaude:end -->`

  const START = '<!-- multiclaude:start -->'
  const END = '<!-- multiclaude:end -->'

  let updated: string
  if (existing.includes(START)) {
    // Replace existing section
    const before = existing.slice(0, existing.indexOf(START))
    const after = existing.slice(existing.indexOf(END) + END.length)
    updated = before + section + after
  } else {
    // Append new section (with blank line separator if file has content)
    updated = existing
      ? existing.trimEnd() + '\n\n' + section + '\n'
      : section + '\n'
  }

  writeFileSync(claudeMdPath, updated)
}

function loadOrchestratorContent(): string {
  // Look for prompts/orchestrator.md relative to dist/ or src/
  const candidates = [
    join(__dirname, '..', 'prompts', 'orchestrator.md'),
    join(__dirname, '..', '..', 'prompts', 'orchestrator.md'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf-8').trim()
  }
  // Fallback: embed minimal instructions inline
  return `# MultiClaude Orchestrator\n\nYou are a MultiClaude orchestrator. Use the multiclaude-coord MCP tools to plan, spawn, and monitor worker agents.`
}
