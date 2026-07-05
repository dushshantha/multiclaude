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

export type ComposerState = 'empty' | 'pending' | 'unknown'

/**
 * Classifies the composer state from raw captured pane content.
 *
 * Returns:
 * - 'unknown': pane shows a busy indicator (Claude is processing — can't tell composer state)
 * - 'pending': submittedText is still visible in the cleaned composer area (not yet submitted)
 * - 'empty': submittedText is gone (was submitted, or composer is idle)
 *
 * Handles four layout styles:
 *   bordered      │ text │ — strips box-drawing before checking
 *   ghost-text    SGR-2 dim placeholders — stripped before checking
 *   busy-footer   "ESC to interrupt" indicator — returns 'unknown'
 *   bare-prompt   plain "> " prompt with no decoration
 */
export function classifyComposerState(rawPane: string, submittedText: string): ComposerState {
  // Busy-footer: Claude is actively processing; composer state is indeterminate
  if (/ESC to interrupt/.test(rawPane)) {
    return 'unknown'
  }

  // Clean: strip dim ghost text, box-drawing borders, remaining ANSI
  const cleaned = cleanComposerLine(rawPane)

  if (submittedText.length > 0 && cleaned.includes(submittedText)) {
    return 'pending'
  }

  return 'empty'
}

/**
 * Strips dim/faint (SGR 2) regions from a string.
 * Removes everything from an SGR sequence containing attribute 2 (dim)
 * until the next SGR 22 (normal intensity) or SGR 0 (full reset).
 */
export function stripAnsiDim(s: string): string {
  // Match SGR sequences that set dim (attribute 2 alone or in a list like 1;2)
  // and remove everything until the closing SGR 22 or SGR 0, or end-of-string.
  return s.replace(/\x1b\[(?:\d+;)*2(?:;\d+)*m(?:(?!\x1b\[(?:22|0)m)[\s\S])*(?:\x1b\[(?:22|0)m)?/g, '')
}

/**
 * Strips box-drawing border characters: │ (U+2502), ┃ (U+2503), and ASCII |.
 */
export function stripBoxDrawing(s: string): string {
  return s.replace(/[│┃|]/g, '')
}

/**
 * Cleans a captured composer line: strips dim ghost text, box-drawing borders,
 * all remaining ANSI escape sequences, and trims whitespace.
 */
export function cleanComposerLine(s: string): string {
  let cleaned = stripAnsiDim(s)
  cleaned = stripBoxDrawing(cleaned)
  // Strip all remaining ANSI escape sequences
  cleaned = cleaned.replace(/\x1b\[[0-9;]*m/g, '')
  return cleaned.trim()
}

/**
 * Captures the visible text of a tmux pane, including ANSI escape sequences.
 * Returns the raw captured text, or empty string on failure.
 */
export function capturePaneText(target: string): string {
  try {
    return execSync(
      `tmux capture-pane -e -p -t ${shellQuote(target)}`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim()
  } catch {
    return ''
  }
}

export interface SendToPaneOptions {
  maxEnterRetries?: number
  retryDelayMs?: number
}

export interface SendToPaneResult {
  sent: boolean
  enterRetries: number
}

/**
 * Sends text to a tmux pane and verifies it was submitted.
 *
 * Types the text via send-keys, presses Enter, then uses capture-pane -e to
 * read back the pane content. If the typed text is still visible in the
 * composer (after stripping dim ghost text and box-drawing borders), retries
 * pressing Enter — never retypes the text.
 *
 * This avoids two known failure modes:
 *   1. Bordered-empty composer misread as "text pending" (box chars stripped)
 *   2. Dim ghost/placeholder text misread as human input (SGR 2 stripped)
 */
export function sendToPane(
  target: string,
  text: string,
  opts: SendToPaneOptions = {},
): SendToPaneResult {
  const maxRetries = opts.maxEnterRetries ?? 3
  const retryDelay = opts.retryDelayMs ?? 100

  // Type the text (without Enter)
  execSync(`tmux send-keys -t ${shellQuote(target)} ${shellQuote(text)}`, { stdio: 'pipe' })

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Press Enter
    execSync(`tmux send-keys -t ${shellQuote(target)} Enter`, { stdio: 'pipe' })

    // Brief pause to let the pane process the keystroke
    if (retryDelay > 0) {
      execSync(`sleep ${retryDelay / 1000}`, { stdio: 'pipe' })
    }

    // Capture the pane and check if text is still in the composer
    const raw = capturePaneText(target)
    const cleaned = cleanComposerLine(raw)

    // If the cleaned pane content no longer contains our text, it was submitted
    if (!cleaned.includes(text)) {
      return { sent: true, enterRetries: attempt }
    }
  }

  return { sent: false, enterRetries: maxRetries }
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
