import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { writeFileSync, mkdirSync, openSync, readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { readWorktreeGitDir } from '../git/worktree.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Returns the shell command to invoke the boundary-guard PreToolUse hook.
 * Prefers the compiled .js (production: dist/spawner/) over tsx source (development).
 */
export function resolveHookCommand(): string {
  const jsPath = join(__dirname, 'worktree-guard-hook.js')
  if (existsSync(jsPath)) {
    return `node ${JSON.stringify(jsPath)}`
  }
  const tsPath = join(__dirname, 'worktree-guard-hook.ts')
  return `npx tsx ${JSON.stringify(tsPath)}`
}

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
  effort?: string
  agentId: string
  worktreePath: string
  mcpConfigPath: string
  openTerminals?: boolean
  /** Absolute path to the parent project repo — used to generate deny rules. */
  repoPath?: string
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

export interface WorktreeIsolation {
  worktreePath: string
  gitDir: string
}

export interface WorkerEnvOpts {
  /** Task ID — forwarded as MULTICLAUDE_TASK_ID for the boundary-guard hook. */
  taskId?: string
  /** Worktree root — forwarded as MULTICLAUDE_WORKTREE when isolation is unavailable. */
  worktreePath?: string
}

export function buildWorkerEnv(agentId: string, isolation?: WorktreeIsolation, opts?: WorkerEnvOpts): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env, MULTICLAUDE_AGENT_ID: agentId }
  delete env['CLAUDECODE']
  if (isolation) {
    env.GIT_DIR = isolation.gitDir
    env.GIT_WORK_TREE = isolation.worktreePath
    env.GIT_CEILING_DIRECTORIES = dirname(isolation.worktreePath)
  }
  // MULTICLAUDE_WORKTREE is inherited by the boundary-guard PreToolUse hook subprocess.
  const worktreePath = isolation?.worktreePath ?? opts?.worktreePath
  if (worktreePath) env.MULTICLAUDE_WORKTREE = worktreePath
  if (opts?.taskId) env.MULTICLAUDE_TASK_ID = opts.taskId
  return env
}

function resolveWorktreeIsolation(worktreePath: string): WorktreeIsolation | undefined {
  try {
    const gitDir = readWorktreeGitDir(worktreePath)
    return { worktreePath, gitDir }
  } catch {
    return undefined
  }
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

  // Only emit --effort when explicitly set to a non-default value ('high' is Claude Code's default)
  const effortFlags = (cfg.effort && cfg.effort !== 'high') ? ['--effort', cfg.effort] : []

  return [
    '--mcp-config', cfg.mcpConfigPath,
    '--allow-dangerously-skip-permissions',
    '--dangerously-skip-permissions',
    '--print',
    ...extraFlags,
    '--output-format', outputFormat,
    '--model', modelId,
    ...effortFlags,
    prompt,
  ]
}

/**
 * Builds the settings.local.json content for a worker's .claude/ directory.
 *
 * Write and Edit permissions are scoped to the worktree path so Claude Code's
 * built-in permission layer blocks obvious out-of-tree writes immediately.
 * The boundary-guard PreToolUse hook catches traversal and symlink escape cases
 * that glob rules cannot express.
 *
 * Bash(*) cannot be path-constrained by glob patterns in Claude Code's
 * permission system — there is no Bash(path) equivalent. Isolation relies on
 * the worktree-scoped cwd, the GIT_DIR/GIT_WORK_TREE env vars in buildWorkerEnv,
 * and the hook (which does not intercept Bash because it cannot determine the
 * effective filesystem paths from the command string alone).
 */
export function buildWorkerSettings(cfg: {
  worktreePath: string
  repoPath?: string
}): object {
  const hookCommand = resolveHookCommand()

  const allow = [
    // Bash cannot be scoped to a path via Claude Code's glob permission format.
    // cwd isolation (worktree as cwd) and GIT_DIR env vars limit its blast radius.
    'Bash(*)',
    `Write(${cfg.worktreePath}/**)`,
    `Edit(${cfg.worktreePath}/**)`,
    'Read(*)',
    'mcp__multiclaude-worker__get_my_task',
    'mcp__multiclaude-worker__report_progress',
    'mcp__multiclaude-worker__report_done',
    'mcp__multiclaude-worker__report_blocked',
  ]

  // Explicitly deny writes to the parent project repo so even if a glob rule
  // were widened in the future, the deny takes precedence.
  const deny: string[] = []
  if (cfg.repoPath) {
    deny.push(`Write(${cfg.repoPath}/**)`, `Edit(${cfg.repoPath}/**)`)
  }

  return {
    permissions: {
      allow,
      ...(deny.length > 0 && { deny }),
    },
    hooks: {
      PreToolUse: [
        {
          // Match every tool — the hook only acts on Write/Edit/Read/NotebookEdit paths.
          matcher: '.*',
          hooks: [{ type: 'command', command: hookCommand }],
        },
      ],
    },
  }
}

export function workerLogPath(agentId: string): string {
  return join(tmpdir(), `mc-worker-${agentId}.log`)
}

export function spawnWorker(cfg: SpawnConfig): ChildProcess {
  // Redirect both stdout and stderr to a log file — captures Claude's full
  // output (reasoning, tool calls, text) for post-mortem debugging and live
  // tailing with: tail -f <path>
  const claudeDir = join(cfg.worktreePath, '.claude')
  try {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify(buildWorkerSettings({ worktreePath: cfg.worktreePath, repoPath: cfg.repoPath }), null, 2)
    )
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`settings_write_failed: ${detail}`)
  }
  const logFd = openSync(workerLogPath(cfg.agentId), 'a')
  const isolation = resolveWorktreeIsolation(cfg.worktreePath)
  return spawn('claude', buildWorkerArgs(cfg), {
    cwd: cfg.worktreePath,
    stdio: ['ignore', logFd, logFd],
    env: buildWorkerEnv(cfg.agentId, isolation, { taskId: cfg.taskId, worktreePath: cfg.worktreePath }),
  })
}

const KNOWN_FAILURE_REASON_PREFIXES = [
  'tmux_window_create_failed',
  'tmux_session_create_failed',
  'settings_write_failed',
  'agent_launch_failed',
] as const

/**
 * Maps a launch error message to a stable machine-readable slug.
 * Functions in tmux.ts and spawnWorker re-throw errors prefixed with a slug
 * (e.g. "tmux_window_create_failed: ...") so the classifier can extract it.
 * Exported for testing.
 */
export function classifyLaunchError(msg: string): string {
  for (const prefix of KNOWN_FAILURE_REASON_PREFIXES) {
    if (msg.startsWith(prefix + ':') || msg === prefix) return prefix
  }
  if (/ENOENT|EACCES|EPERM|EISDIR/.test(msg)) return 'settings_write_failed'
  return 'agent_launch_failed'
}

export function writeWorkerMcpConfig(serverPort: number, configDir: string = tmpdir()): string {
  const config = buildWorkerMcpConfig({ serverPort })
  const path = join(configDir, 'mc-worker-mcp-config.json')
  writeFileSync(path, JSON.stringify(config, null, 2))
  return path
}
