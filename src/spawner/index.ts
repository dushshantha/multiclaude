import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { writeFileSync, mkdirSync, openSync, readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const MODEL_IDS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
}

export interface SpawnConfig {
  taskId: string
  taskTitle: string
  taskDescription?: string
  model?: string
  agentId: string
  worktreePath: string
  mcpConfigPath: string
  openTerminals?: boolean
}

export interface WorkerMcpConfig {
  mcpServers: Record<string, { url: string; type: string }>
}

export function buildWorkerMcpConfig(opts: { serverPort: number }): WorkerMcpConfig {
  return {
    mcpServers: {
      // Use a distinct name so it doesn't conflict with the user-level
      // 'multiclaude-coord' (orchestrator endpoint) in ~/.claude.json.
      'multiclaude-worker': {
        type: 'http',
        url: `http://localhost:${opts.serverPort}/worker`,
      },
    },
  }
}

export function buildWorkerEnv(agentId: string): NodeJS.ProcessEnv {
  const env = { ...process.env, MULTICLAUDE_AGENT_ID: agentId }
  // Remove CLAUDECODE so spawned workers don't fail with "nested session" error
  // if multiclaude was itself started from within a Claude Code session.
  delete (env as Record<string, string | undefined>)['CLAUDECODE']
  return env
}

function loadWorkerPrompt(): string {
  // Look for prompts/worker.md relative to dist/ or src/
  const candidates = [
    join(__dirname, '..', 'prompts', 'worker.md'),
    join(__dirname, '..', '..', 'prompts', 'worker.md'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf-8').trim()
  }
  // Fallback: minimal inline instructions if file not found
  return [
    'Your MCP server is "multiclaude-worker". Start by calling get_my_task with your agent_id to get full task context, then implement the task.',
    'Use report_progress to send status updates at key checkpoints.',
    'When complete, call report_done with a summary. If blocked, call report_blocked.',
  ].join('\n')
}

export function buildWorkerArgs(cfg: SpawnConfig): string[] {
  const workerInstructions = loadWorkerPrompt()
  const prompt = [
    `You are MultiClaude worker agent "${cfg.agentId}".`,
    `Your assigned task is: "${cfg.taskTitle}"`,
    cfg.taskDescription ? `\nDescription: ${cfg.taskDescription}` : '',
    `\n\nYour agent ID is: ${cfg.agentId}`,
    `\n\n${workerInstructions}`,
  ].join('')

  // Use stream-json when not showing in a terminal window — the exit handler
  // in cli.ts parses the result message to extract token usage counts.
  // Use text format when opening terminal windows so the output is readable.
  const outputFormat = cfg.openTerminals ? 'text' : 'stream-json'
  const extraFlags = cfg.openTerminals ? [] : ['--verbose']

  const modelKey = cfg.model ?? 'sonnet'
  const modelId = MODEL_IDS[modelKey] ?? MODEL_IDS.sonnet

  return [
    '--mcp-config', cfg.mcpConfigPath,
    '--allow-dangerously-skip-permissions',
    '--dangerously-skip-permissions',
    '--print',
    ...extraFlags,
    '--output-format', outputFormat,
    '--model', modelId,
    prompt,
  ]
}

export function workerLogPath(agentId: string): string {
  return join(tmpdir(), `mc-worker-${agentId}.log`)
}

export function spawnWorker(cfg: SpawnConfig): ChildProcess {
  // Redirect both stdout and stderr to a log file — captures Claude's full
  // output (reasoning, tool calls, text) for post-mortem debugging and live
  // tailing with: tail -f <path>
  const claudeDir = join(cfg.worktreePath, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(
    join(claudeDir, 'settings.local.json'),
    JSON.stringify({ permissions: { allow:
      ['Bash(*)', 'Write(*)', 'Edit(*)', 'Read(*)',
        'mcp__multiclaude-worker__get_my_task',
        'mcp__multiclaude-worker__report_progress',
        'mcp__multiclaude-worker__report_done',
        'mcp__multiclaude-worker__report_blocked'
      ]
     } }, null, 2)
  )
  const logFd = openSync(workerLogPath(cfg.agentId), 'a')
  return spawn('claude', buildWorkerArgs(cfg), {
    cwd: cfg.worktreePath,
    stdio: ['ignore', logFd, logFd],
    env: buildWorkerEnv(cfg.agentId),
  })
}

export function writeWorkerMcpConfig(serverPort: number, configDir: string = tmpdir()): string {
  const config = buildWorkerMcpConfig({ serverPort })
  const path = join(configDir, 'mc-worker-mcp-config.json')
  writeFileSync(path, JSON.stringify(config, null, 2))
  return path
}
