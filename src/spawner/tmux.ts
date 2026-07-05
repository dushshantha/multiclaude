import { execSync, spawn } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

import type { SpawnConfig } from './index.js'
import { buildWorkerArgs, buildWorkerEnv } from './index.js'
import type { WorkerHandle } from './backend.js'

/**
 * Captures the last `lines` lines of a tmux pane using capture-pane.
 * Returns empty string if tmux is unavailable or the target doesn't exist.
 */
export function captureTmuxPane(target: string, lines: number = 40): string {
  try {
    return execSync(
      `tmux capture-pane -p -t ${shellQuote(target)} -S -${lines}`,
      { encoding: 'utf8', stdio: 'pipe' }
    )
  } catch {
    return ''
  }
}

/** Single-quote a string for POSIX shell — handles embedded single quotes. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Returns the tmux session to target.
 * - If running inside tmux ($TMUX is set), returns the current session name.
 * - Otherwise ensures a detached 'multiclaude' session exists and returns its name.
 */
export function ensureTmuxSession(): string {
  if (process.env.TMUX) {
    return execSync('tmux display-message -p "#{session_name}"', { encoding: 'utf8' }).trim()
  }

  const sessionName = 'multiclaude'
  try {
    execSync(`tmux has-session -t ${shellQuote(sessionName)}`, { stdio: 'pipe' })
  } catch {
    // Session does not exist — create it detached
    execSync(`tmux new-session -d -s ${shellQuote(sessionName)}`, { stdio: 'pipe' })
  }
  return sessionName
}

/**
 * Creates a tmux window named mc-<taskId> in the given session,
 * rooted at worktreePath. Returns the window target (session:window).
 */
export function createTmuxWindow(sessionName: string, taskId: string, worktreePath: string): string {
  const windowName = `mc-${taskId}`
  execSync(
    `tmux new-window -d -t ${shellQuote(sessionName)}: -n ${shellQuote(windowName)} -c ${shellQuote(worktreePath)}`,
    { stdio: 'pipe' }
  )
  return `${sessionName}:${windowName}`
}

/**
 * Returns the shell PID of the given tmux pane target, or undefined on failure.
 */
export function getTmuxPanePid(target: string): number | undefined {
  try {
    const raw = execSync(
      `tmux display-message -t ${shellQuote(target)} -p '#{pane_pid}'`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim()
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? n : undefined
  } catch {
    return undefined
  }
}

/**
 * Sends a line of text to a tmux pane as keystrokes, followed by Enter.
 */
export function sendTmuxKeys(target: string, command: string): void {
  execSync(`tmux send-keys -t ${shellQuote(target)} ${shellQuote(command)} Enter`, { stdio: 'pipe' })
}

/**
 * Writes a self-contained bash launch script for the worker into the worktree's
 * .claude directory. Returns the script path.
 *
 * Using a script file sidesteps shell-quoting the long prompt string inline in
 * the send-keys command.
 */
export function writeLaunchScript(cfg: SpawnConfig): string {
  const args = buildWorkerArgs({ ...cfg, openTerminals: true })
  const env = buildWorkerEnv(cfg.agentId)

  const lines: string[] = ['#!/usr/bin/env bash', 'set -e', '']
  for (const [key, val] of Object.entries(env)) {
    if (val !== undefined) {
      lines.push(`export ${key}=${shellQuote(val)}`)
    }
  }
  lines.push('')
  lines.push(`exec claude ${args.map(shellQuote).join(' ')}`)
  lines.push('')

  const scriptPath = join(cfg.worktreePath, '.claude', 'worker-launch.sh')
  writeFileSync(scriptPath, lines.join('\n'), { mode: 0o755 })
  return scriptPath
}

/**
 * Spawns a Claude worker inside a tmux window.
 *
 * Flow:
 *   1. Ensure a tmux session (reuse $TMUX session, or create/reuse 'multiclaude')
 *   2. Create a window named mc-<taskId> rooted at the worktree path
 *   3. Write a launch script and send it to the pane via send-keys
 *   4. Append `; tmux wait-for -S <signal>` so exit is detectable
 *   5. Spawn a monitor child process running `tmux wait-for <signal>`
 *      which unblocks when the pane's command finishes
 *
 * The agent runs inside the window and is attachable with `tmux attach`.
 */
export function spawnTmuxWorker(cfg: SpawnConfig): WorkerHandle {
  const claudeDir = join(cfg.worktreePath, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(
    join(claudeDir, 'settings.local.json'),
    JSON.stringify({ permissions: { allow: [
      'Bash(*)', 'Write(*)', 'Edit(*)', 'Read(*)',
      'mcp__multiclaude-worker__get_my_task',
      'mcp__multiclaude-worker__report_progress',
      'mcp__multiclaude-worker__report_done',
      'mcp__multiclaude-worker__report_blocked',
    ] } }, null, 2)
  )

  const sessionName = ensureTmuxSession()
  const windowTarget = createTmuxWindow(sessionName, cfg.taskId, cfg.worktreePath)
  const panePid = getTmuxPanePid(windowTarget)

  const scriptPath = writeLaunchScript(cfg)
  const waitSignal = `mc-${cfg.taskId}-exit`

  // Run the script; signal when done so the monitor below detects exit
  sendTmuxKeys(windowTarget, `bash ${shellQuote(scriptPath)}; tmux wait-for -S ${shellQuote(waitSignal)}`)

  // Monitor blocks until the signal fires (claude exits in the pane)
  const monitor = spawn('tmux', ['wait-for', waitSignal], {
    stdio: 'ignore',
    detached: false,
  })

  return {
    pid: panePid,
    tmuxPane: windowTarget,
    onExit(cb) { monitor.on('exit', cb) },
    onError(cb) { monitor.on('error', cb) },
  }
}
