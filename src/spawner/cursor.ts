import pty from 'node-pty'
import type { IPty } from 'node-pty'
import { writeFileSync, mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'

import type { SpawnConfig } from './index.js'
import { workerLogPath } from './index.js'

// Cursor MCP config format (written to <worktree>/.cursor/mcp.json)
export interface CursorMcpConfig {
  mcpServers: Record<string, { url: string; type: string }>
}

export function buildCursorWorkerMcpConfig(opts: { serverPort: number }): CursorMcpConfig {
  return {
    mcpServers: {
      'multiclaude-worker': {
        type: 'http',
        url: `http://localhost:${opts.serverPort}/worker`,
      },
    },
  }
}

/**
 * Writes .cursor/mcp.json in the worktree directory so Cursor picks up the
 * multiclaude-worker MCP server without needing a --mcp-config CLI flag.
 */
export function writeCursorWorkerMcpConfig(opts: {
  serverPort: number
  worktreePath: string
}): void {
  const cursorDir = join(opts.worktreePath, '.cursor')
  mkdirSync(cursorDir, { recursive: true })
  const config = buildCursorWorkerMcpConfig({ serverPort: opts.serverPort })
  writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify(config, null, 2))
}

/**
 * Builds the content for the .cursor/rules/multiclaude-worker.mdc rules file.
 * This is the equivalent of the --print prompt that Claude workers receive via
 * buildWorkerArgs() in index.ts — Cursor reads rules from the filesystem
 * instead of accepting them as a CLI argument.
 */
export function buildCursorWorkerRules(cfg: Pick<SpawnConfig, 'agentId' | 'taskTitle' | 'taskDescription'>): string {
  const prompt = [
    `You are MultiClaude worker agent "${cfg.agentId}".`,
    `Your assigned task is: "${cfg.taskTitle}"`,
    cfg.taskDescription ? `\nDescription: ${cfg.taskDescription}` : '',
    `\n\nYour agent ID is: ${cfg.agentId}`,
    '\nYour MCP server is "multiclaude-worker". Start by calling get_my_task with your agent_id to get full task context, then implement the task.',
    '\nUse report_progress to send status updates at key checkpoints.',
    '\nWhen complete, call report_done with a summary. If blocked, call report_blocked.',
  ].join('')

  // MDC (Markdown with Cursor frontmatter) format
  return [
    '---',
    'description: MultiClaude worker task instructions',
    'alwaysApply: true',
    '---',
    '',
    prompt,
    '',
  ].join('\n')
}

/**
 * Writes .cursor/rules/multiclaude-worker.mdc in the worktree so Cursor
 * injects the worker task prompt automatically on startup.
 */
export function writeCursorWorkerRules(cfg: SpawnConfig): void {
  const rulesDir = join(cfg.worktreePath, '.cursor', 'rules')
  mkdirSync(rulesDir, { recursive: true })
  const content = buildCursorWorkerRules(cfg)
  writeFileSync(join(rulesDir, 'multiclaude-worker.mdc'), content)
}

/**
 * Returns CLI args for the Cursor agent. Unlike Claude workers, Cursor reads
 * its MCP config from .cursor/mcp.json in the working directory, so there is
 * no --mcp-config flag.
 */
export function buildCursorWorkerArgs(): string[] {
  return [
    '--print',
    '--output-format', 'stream-json',
  ]
}

/**
 * Builds the environment for a Cursor worker process.
 * Strips Cursor-specific env vars that would cause "nested session" errors
 * when multiclaude is itself launched from within a Cursor session, analogous
 * to how CLAUDECODE is stripped for Claude workers.
 */
export function buildCursorWorkerEnv(agentId: string): NodeJS.ProcessEnv {
  const env = { ...process.env, MULTICLAUDE_AGENT_ID: agentId }
  const envRecord = env as Record<string, string | undefined>

  // Cursor sets these vars in its embedded terminal / agent runner.
  // Strip them so spawned workers don't trigger nested-session guards.
  delete envRecord['CURSOR']
  delete envRecord['CURSOR_TRACE_ID']
  delete envRecord['CURSOR_SESSION_ID']
  delete envRecord['CURSOR_CHANNEL']

  return env
}

/**
 * Spawns a Cursor agent worker using node-pty.
 *
 * node-pty is required because the Cursor CLI requires a real TTY — without
 * one it hangs waiting for terminal input and never starts processing.
 *
 * PTY output is streamed to the same log file path as Claude workers
 * (workerLogPath(agentId)) so tailing behaviour is consistent:
 *   tail -f $(npx tsx -e "import {workerLogPath} from './src/spawner/index.js'; console.log(workerLogPath('my-agent'))")
 */
export function spawnCursorWorker(cfg: SpawnConfig & { serverPort: number }): IPty {
  // Write MCP config and rules into the worktree before starting
  writeCursorWorkerMcpConfig({ serverPort: cfg.serverPort, worktreePath: cfg.worktreePath })
  writeCursorWorkerRules(cfg)

  const logPath = workerLogPath(cfg.agentId)
  const args = buildCursorWorkerArgs()
  const env = buildCursorWorkerEnv(cfg.agentId)

  const ptyProcess = pty.spawn('cursor', args, {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd: cfg.worktreePath,
    env: env as Record<string, string>,
  })

  // Stream all PTY output to the log file (same pattern as Claude worker log)
  ptyProcess.onData((data: string) => {
    appendFileSync(logPath, data)
  })

  return ptyProcess
}
