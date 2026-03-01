import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { writeFileSync, openSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export interface SpawnConfig {
  taskId: string
  taskTitle: string
  taskDescription?: string
  agentId: string
  worktreePath: string
  mcpConfigPath: string
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

export function buildWorkerArgs(cfg: SpawnConfig): string[] {
  const prompt = [
    `You are MultiClaude worker agent "${cfg.agentId}".`,
    `Your assigned task is: "${cfg.taskTitle}"`,
    cfg.taskDescription ? `\nDescription: ${cfg.taskDescription}` : '',
    `\n\nYour agent ID is: ${cfg.agentId}`,
    '\nYour MCP server is "multiclaude-worker". Start by calling get_my_task with your agent_id to get full task context, then implement the task.',
    '\nUse report_progress to send status updates at key checkpoints.',
    '\nWhen complete, call report_done with a summary. If blocked, call report_blocked.',
  ].join('')

  return [
    '--mcp-config', cfg.mcpConfigPath,
    '--dangerously-skip-permissions',
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
