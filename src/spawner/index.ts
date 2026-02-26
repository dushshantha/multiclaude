import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export interface SpawnConfig {
  taskId: string
  taskTitle: string
  taskDescription?: string
  worktreePath: string
  mcpConfigPath: string
}

export interface WorkerMcpConfig {
  mcpServers: Record<string, { url: string; type: string }>
}

export function buildWorkerMcpConfig(opts: { serverPort: number }): WorkerMcpConfig {
  return {
    mcpServers: {
      'multiclaude-coord': {
        type: 'sse',
        url: `http://localhost:${opts.serverPort}/worker`,
      },
    },
  }
}

export function buildWorkerArgs(cfg: SpawnConfig): string[] {
  const prompt = [
    `Your assigned task is: "${cfg.taskTitle}"`,
    cfg.taskDescription ? `\nDescription: ${cfg.taskDescription}` : '',
    '\n\nYou have access to multiclaude-coord MCP tools.',
    '\nStart by calling get_my_task() to get full task context, then implement the task.',
    '\nUse report_progress() to send status updates.',
    '\nUse report_done() when complete. Use report_blocked() if you encounter errors.',
  ].join('')

  return [
    '--mcp-config', cfg.mcpConfigPath,
    '--dangerously-skip-permissions',
    prompt,
  ]
}

export function spawnWorker(cfg: SpawnConfig): ChildProcess {
  return spawn('claude', buildWorkerArgs(cfg), {
    cwd: cfg.worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })
}

export function writeWorkerMcpConfig(serverPort: number, configDir: string = tmpdir()): string {
  const config = buildWorkerMcpConfig({ serverPort })
  const path = join(configDir, 'mc-worker-mcp-config.json')
  writeFileSync(path, JSON.stringify(config, null, 2))
  return path
}
