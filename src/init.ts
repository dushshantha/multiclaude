import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { writeConfig } from './config.js'
import type { WorkerRuntime } from './config.js'
import { checkIsGitRepo, getRemoteUrl, parseGitHubRemote } from './git/ops.js'
import { isGhAvailable, isGhAuthenticated } from './git/pr.js'
import { ORCHESTRATOR_TOOL_NAMES } from './server/tool-names.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const MULTICLAUDE_PERMISSIONS = [
  // Orchestrator tools — derived from ORCHESTRATOR_TOOL_NAMES so this list
  // stays in sync with the server registration automatically.
  ...ORCHESTRATOR_TOOL_NAMES.map(n => `mcp__multiclaude-coord__${n}`),
  // Worker tools — accessed via 'multiclaude-worker' MCP server (injected via --mcp-config)
  'mcp__multiclaude-worker__get_my_task',
  'mcp__multiclaude-worker__report_progress',
  'mcp__multiclaude-worker__report_done',
  'mcp__multiclaude-worker__report_blocked',
  // Orchestrator Bash access — gh only, for fetching GitHub issue/PR context
  'Bash(gh:*)',
  'Bash(npm install:*)',
  'Bash(npm test:*)',
  'Bash(npm start:*)',
  'Bash(node:*)',
  'Bash(curl:*)',
  'Bash(lsof:*)',
]

export interface InitOptions {
  projectDir?: string
  /** Worker runtime to use. Defaults to 'claude' for backwards compatibility. */
  runtime?: WorkerRuntime
}

export interface PreflightResult {
  isGitRepo: boolean
  hasOriginRemote: boolean
  isGitHubRemote: boolean
  ghAvailable: boolean
  ghAuthenticated: boolean
  hasToken: boolean
  warnings: string[]
}

export async function runPreflightChecks(projectDir: string): Promise<PreflightResult> {
  const result: PreflightResult = {
    isGitRepo: false,
    hasOriginRemote: false,
    isGitHubRemote: false,
    ghAvailable: false,
    ghAuthenticated: false,
    hasToken: false,
    warnings: [],
  }

  result.isGitRepo = await checkIsGitRepo(projectDir)
  if (!result.isGitRepo) {
    result.warnings.push(
      'Not a git repo — run: git init && git remote add origin <url>',
    )
    return result
  }

  const remoteUrl = await getRemoteUrl(projectDir)
  result.hasOriginRemote = remoteUrl !== null
  if (!result.hasOriginRemote) {
    result.warnings.push(
      'No origin remote — create_pr will not be able to open PRs until you add one: git remote add origin <url>',
    )
  } else {
    const parsed = parseGitHubRemote(remoteUrl!)
    result.isGitHubRemote = parsed !== null
    if (!result.isGitHubRemote) {
      result.warnings.push(
        `origin remote (${remoteUrl}) is not a GitHub URL — create_pr requires a github.com remote`,
      )
    } else {
      result.hasToken = !!(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)
      result.ghAvailable = await isGhAvailable()
      if (result.ghAvailable) {
        result.ghAuthenticated = await isGhAuthenticated(projectDir)
        if (!result.ghAuthenticated && !result.hasToken) {
          result.warnings.push(
            'gh CLI not authenticated and no GITHUB_TOKEN/GH_TOKEN set — run: gh auth login',
          )
        }
      } else if (!result.hasToken) {
        result.warnings.push(
          'gh CLI not installed and no GITHUB_TOKEN/GH_TOKEN set — PR creation will fail. Install gh from https://cli.github.com/ or set GITHUB_TOKEN',
        )
      }
    }
  }

  return result
}

export async function runInit(opts: InitOptions = {}): Promise<void> {
  const projectDir = resolve(opts.projectDir ?? process.cwd())
  const runtime: WorkerRuntime = opts.runtime ?? 'claude'

  writeConfig(projectDir, { workerRuntime: runtime })
  updateSettings(projectDir)

  if (runtime === 'cursor') {
    updateCursorRules(projectDir)
    console.log(`✓ MultiClaude initialized in ${projectDir} (Cursor mode)`)
    console.log(`  .multiclaude.json — workerRuntime: cursor`)
    console.log(`  .claude/settings.local.json — permissions added`)
    console.log(`  .cursor/rules/multiclaude-orchestrator.mdc — orchestrator instructions added`)
  } else {
    updateClaudeMd(projectDir)
    const suffix = runtime === 'tmux' ? ' (tmux mode)' : ''
    console.log(`✓ MultiClaude initialized in ${projectDir}${suffix}`)
    console.log(`  .multiclaude.json — workerRuntime: ${runtime}`)
    console.log(`  .claude/settings.local.json — permissions added`)
    console.log(`  CLAUDE.md — orchestrator instructions added`)
    if (runtime === 'tmux') {
      console.log(`\nWorkers will run inside tmux windows named mc-<taskId>.`)
      console.log(`Attach with: tmux attach -t multiclaude`)
    }
  }

  console.log(`\nMake sure MultiClaude is running: multiclaude start`)
  console.log('Then just run:                    ' + (runtime === 'cursor' ? 'cursor agent' : 'claude') + '   (from this directory)')

  const preflight = await runPreflightChecks(projectDir)
  if (preflight.warnings.length > 0) {
    console.log('\n⚠️  Setup warnings (init succeeded — these are non-blocking):')
    for (const w of preflight.warnings) {
      console.log(`   • ${w}`)
    }
  }
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

function updateCursorRules(projectDir: string): void {
  const cursorRulesDir = join(projectDir, '.cursor', 'rules')
  mkdirSync(cursorRulesDir, { recursive: true })

  const mdcPath = join(cursorRulesDir, 'multiclaude-orchestrator.mdc')
  const orchestratorContent = loadOrchestratorContent()

  writeFileSync(mdcPath, orchestratorContent + '\n')
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
