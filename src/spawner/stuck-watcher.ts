import type Database from 'better-sqlite3'
import { getTask, updateTask } from '../server/state/tasks.js'
import { updateAgent } from '../server/state/agents.js'
import { captureTmuxPane, killTmuxWindow, getChildProcessPid } from './tmux.js'

interface RunningAgentRow {
  id: string
  task_id: string | null
  status: string
  tmux_pane: string | null
}

const BUSY_PATTERNS = [
  /esc to interrupt/i,
  /working\.\.\./i,
]

/** Canonical failure reason written to logs when an agent never called get_my_task. */
export const AGENT_NEVER_STARTED_REASON = 'agent process never started'

// Timing constants for the agent-start verification polling loop.
// Keep the 2s initial delay (lets send-keys settle), then poll every 1.5s for up to
// 30 attempts ≈ 47s total — enough headroom for a cold claude start with an MCP config.
export const VERIFY_INITIAL_DELAY_MS = 2000
export const VERIFY_INTERVAL_MS = 1500
export const VERIFY_MAX_ATTEMPTS = 30

/**
 * Returns true if the captured pane text contains a Claude Code busy footer
 * in the last ~6 non-blank lines, indicating the worker is mid-turn.
 */
export function isPaneBusy(paneText: string): boolean {
  // Strip ANSI escape sequences before matching
  const stripped = paneText.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  const lastLines = stripped
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .slice(-6)
  return lastLines.some(line => BUSY_PATTERNS.some(p => p.test(line)))
}

/**
 * Check all running agents for stuck workers and take action:
 * - If the agent has a tmux pane and it shows a busy footer, skip (worker is mid-turn)
 * - Warn (insert a log entry) if no log activity for >= stuckWarningMinutes
 * - Fail (mark task failed) if no log activity for >= stuckTimeoutMinutes
 *
 * Also checks `spawning` agents (those that were launched but never called get_my_task):
 * - If started_at is > firstActivitySeconds ago and still no log entries, the agent
 *   process likely never started — mark failed immediately with AGENT_NEVER_STARTED_REASON.
 *   This is a much tighter bound than the general staleness window and catches the
 *   "Enter never landed in tmux" fault at spawn time rather than 10+ minutes later.
 *
 * `stuckSince` is an in-memory Map<taskId, timestamp> tracking the first time
 * we noticed a worker was stuck — callers must pass the same Map across calls.
 *
 * `capturePane` and `killWindow` are injectable for testing; default to real impls.
 */
export function checkStuckWorkers(
  db: Database.Database,
  stuckSince: Map<string, number>,
  stuckWarningMinutes: number,
  stuckTimeoutMinutes: number,
  now: number = Date.now(),
  capturePane: (target: string, lines: number) => string = captureTmuxPane,
  killWindow: (windowId: string) => void = killTmuxWindow,
  firstActivitySeconds: number = 60,
): void {
  // --- First-activity heartbeat: spawning agents with no logs after firstActivitySeconds ---
  // An agent that was launched but never called get_my_task (and thus never wrote a log)
  // has almost certainly not started. Fail it quickly rather than waiting for the general
  // staleness window (stuckTimeoutMinutes, typically 10-30 min).
  const spawningAgents = db.prepare(
    "SELECT id, task_id, status, tmux_pane FROM agents WHERE status = 'spawning'"
  ).all() as RunningAgentRow[]

  for (const agent of spawningAgents) {
    if (!agent.task_id) continue
    const task = getTask(db, agent.task_id)
    if (!task || task.status !== 'in_progress') continue

    // Skip if ANY log entry already exists — the agent is doing something
    const logCount = (db.prepare(
      'SELECT COUNT(*) AS cnt FROM logs WHERE task_id = ?'
    ).get(agent.task_id) as { cnt: number }).cnt
    if (logCount > 0) continue

    const startMs = task.started_at ? new Date(task.started_at).getTime() : now
    const elapsedSeconds = (now - startMs) / 1000

    if (elapsedSeconds >= firstActivitySeconds) {
      console.warn(
        `[stuck-watcher] Task ${task.id} shows no activity ${firstActivitySeconds}s after spawn — agent likely never started`
      )
      updateTask(db, task.id, { status: 'failed' })
      updateAgent(db, agent.id, { status: 'failed' })
      db.prepare(
        'INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)'
      ).run(task.id, 'error', AGENT_NEVER_STARTED_REASON)
      if (agent.tmux_pane) killWindow(agent.tmux_pane)
    }
  }

  // --- Existing staleness check for running agents ---
  const runningAgents = db.prepare(
    "SELECT id, task_id, status, tmux_pane FROM agents WHERE status = 'running'"
  ).all() as RunningAgentRow[]

  for (const agent of runningAgents) {
    if (!agent.task_id) continue
    const task = getTask(db, agent.task_id)
    if (!task || task.status !== 'in_progress') continue

    // If the worker has a visible tmux pane, check for a busy footer first.
    // A busy pane means Claude is mid-turn — not stuck.
    if (agent.tmux_pane) {
      const paneText = capturePane(agent.tmux_pane, 6)
      if (isPaneBusy(paneText)) {
        stuckSince.delete(task.id)
        continue
      }
    }

    // Most recent log entry for this task
    const logRow = db.prepare(
      'SELECT MAX(created_at) AS last_log FROM logs WHERE task_id = ?'
    ).get(agent.task_id) as { last_log: string | null }

    // Fall back to task start time when no logs exist yet
    const referenceIso = logRow.last_log ?? task.started_at
    const referenceMs = referenceIso ? new Date(referenceIso).getTime() : now
    const idleMs = now - referenceMs
    const idleMinutes = idleMs / 60_000

    if (idleMinutes >= stuckTimeoutMinutes) {
      console.warn(
        `[stuck-watcher] Task ${task.id} timed out after ${stuckTimeoutMinutes}m with no log activity`
      )
      updateTask(db, task.id, { status: 'failed' })
      updateAgent(db, agent.id, { status: 'failed' })
      db.prepare(
        'INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)'
      ).run(task.id, 'error', `timed out after ${stuckTimeoutMinutes}m with no log activity`)
      // Reap the tmux window so it doesn't accumulate as a dead pane
      if (agent.tmux_pane) killWindow(agent.tmux_pane)
      stuckSince.delete(task.id)
    } else if (idleMinutes >= stuckWarningMinutes) {
      if (!stuckSince.has(task.id)) {
        stuckSince.set(task.id, now)
        console.warn(
          `[stuck-watcher] Task ${task.id} has had no log activity for ${Math.round(idleMinutes)}m`
        )
        db.prepare(
          'INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)'
        ).run(task.id, 'warn', `no log activity for ${Math.round(idleMinutes)}m (stuck warning)`)
      }
    } else {
      // Activity resumed — clear any stuck tracking
      stuckSince.delete(task.id)
    }
  }
}

/**
 * Polls asynchronously to verify that a tmux worker actually launched a claude process.
 * At spawn time we record the pane shell's PID, but claude runs as a child of that shell.
 * We poll for a child process of panePid; if none appears within the window we capture
 * the pane and check `isPaneBusy` — a busy footer means Claude is mid-turn and the
 * agent IS alive, so we reset the counter and keep waiting instead of declaring failure.
 *
 * Injectable for testing: getChildPid, capturePane, killWindow, and schedule.
 */
export function startVerifyAgentStarted(
  db: Database.Database,
  panePid: number,
  agentId: string,
  taskId: string,
  paneId: string,
  getChildPid: (pid: number) => number | undefined = getChildProcessPid,
  capturePane: (target: string, lines: number) => string = captureTmuxPane,
  killWindow: (windowId: string) => void = killTmuxWindow,
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms) },
  maxAttempts: number = VERIFY_MAX_ATTEMPTS,
  intervalMs: number = VERIFY_INTERVAL_MS,
  initialDelayMs: number = VERIFY_INITIAL_DELAY_MS,
): void {
  let attempts = 0

  const poll = () => {
    const agentRow = db.prepare('SELECT status FROM agents WHERE id = ?')
      .get(agentId) as { status: string } | undefined
    if (agentRow?.status !== 'spawning') return

    const childPid = getChildPid(panePid)
    if (childPid !== undefined) {
      updateAgent(db, agentId, { pid: childPid })
      return
    }

    attempts++
    if (attempts < maxAttempts) {
      schedule(poll, intervalMs)
      return
    }

    // All attempts exhausted — check busy footer before declaring failure.
    // A pane showing "ESC to interrupt" means the worker is alive and mid-turn.
    const paneText = capturePane(paneId, 6)
    if (isPaneBusy(paneText)) {
      attempts = 0
      schedule(poll, intervalMs)
      return
    }

    // Final guard: another handler may have already transitioned the agent
    const current = db.prepare('SELECT status FROM agents WHERE id = ?')
      .get(agentId) as { status: string } | undefined
    if (current?.status !== 'spawning') return

    console.warn(`[spawner] ${AGENT_NEVER_STARTED_REASON} for agent ${agentId}`)
    updateAgent(db, agentId, { status: 'failed' })
    const t = getTask(db, taskId)
    if (t && t.status !== 'done' && t.status !== 'failed') {
      updateTask(db, taskId, { status: 'failed' })
    }
    db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
      taskId, 'error', AGENT_NEVER_STARTED_REASON
    )
    killWindow(paneId)
  }

  schedule(poll, initialDelayMs)
}
