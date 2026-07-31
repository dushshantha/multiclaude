#!/usr/bin/env node
import { startCoordServer } from './server/index.js'
import { startWebServer } from './web/server.js'
import { startTui } from './tui/index.js'
import { writeWorkerMcpConfig, workerLogPath, classifyLaunchError } from './spawner/index.js'
import { createBackend } from './spawner/backend.js'
import type { RuntimeBackend } from './spawner/backend.js'
import { openWorkerTerminal } from './spawner/terminal.js'
import { getTask, updateTask, listTasks } from './server/state/tasks.js'
import { updateAgent } from './server/state/agents.js'
import { handleSpawnWorker } from './server/tools/orchestrator.js'
import { checkStuckWorkers, AGENT_NEVER_STARTED_REASON } from './spawner/stuck-watcher.js'
import { killTmuxWindow, getChildProcessPid, reapOrphanWindows } from './spawner/tmux.js'
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { runInit } from './init.js'
import { readConfig } from './config.js'
import type { WorkerRuntime } from './config.js'
import type Database from 'better-sqlite3'

interface AgentRow {
  id: string
  task_id: string | null
  cwd: string | null
  pid: number | null
  status: string
}

/**
 * Scans a worker log file for non-JSON lines, which are CLI stderr output
 * (warnings, errors from the claude binary itself rather than Claude's responses).
 * These surface issues like unrecognised flags so they appear in the task log
 * without requiring the user to open the log file or tmux pane.
 */
function parseCliWarnings(logPath: string): string[] {
  try {
    const lines = readFileSync(logPath, 'utf8').split('\n')
    const result: string[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { JSON.parse(trimmed); continue } catch { /* not JSON — likely CLI stderr */ }
      result.push(trimmed)
    }
    return result
  } catch { return [] }
}

function parseTokensFromLog(logPath: string): { input_tokens?: number; output_tokens?: number; total_tokens?: number } {
  try {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').reverse()
    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'result' && msg.usage) {
          const input_tokens: number | undefined = msg.usage.input_tokens
          const output_tokens: number | undefined = msg.usage.output_tokens
          const total_tokens = (input_tokens ?? 0) + (output_tokens ?? 0) || undefined
          return { input_tokens, output_tokens, total_tokens }
        }
      } catch { /* not JSON */ }
    }
  } catch { /* file not found or unreadable */ }
  return {}
}

function startSpawnerWatcher(
  db: Database.Database,
  mcpConfigPath: string,
  backend: RuntimeBackend,
  openTerminals: boolean = false,
  stuckWarningMinutes: number = 10,
  stuckTimeoutMinutes: number = 30,
): void {
  const launched = new Set<string>()
  const retried = new Set<string>()  // tracks "{taskId}-{retryAttempt}" to avoid double-spawning

  setInterval(() => {
    // Auto-retry failed tasks that still have remaining retries
    const failedTasks = listTasks(db, 'failed').filter(t => t.retry_count < t.max_retries)
    for (const task of failedTasks) {
      const retryAttempt = task.retry_count + 1
      const retryKey = `${task.id}-${retryAttempt}`
      if (retried.has(retryKey)) continue
      retried.add(retryKey)

      // Find cwd from the most recent agent for this task, or fall back to repo_path
      // (repo_path is saved early in handleSpawnWorker before worktree creation, so it
      // exists even when the agent was never registered due to a worktree creation failure).
      const prevAgent = db.prepare(
        "SELECT * FROM agents WHERE task_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get(task.id) as AgentRow | undefined

      const retryCwd = prevAgent?.cwd ?? task.repo_path ?? null
      if (!retryCwd) {
        console.warn(`[spawner] Cannot retry task ${task.id}: no cwd found for previous agent`)
        continue
      }

      // Get failure reason from the most recent error/warn log entry (skip info-level
      // "Retry attempt" messages so the reason doesn't nest recursively on each retry)
      const lastLog = db.prepare(
        "SELECT message FROM logs WHERE task_id = ? AND level IN ('error', 'warn') ORDER BY created_at DESC LIMIT 1"
      ).get(task.id) as { message: string } | undefined
      const failureReason = lastLog?.message ?? 'unknown reason'

      const newAgentId = `w-${task.id}-retry${retryAttempt}`
      console.log(`[spawner] Retrying task ${task.id} (attempt ${retryAttempt}/${task.max_retries}): ${failureReason}`)

      // Increment retry count and reset to pending before re-spawning
      updateTask(db, task.id, { retry_count: retryAttempt, status: 'pending' })

      // Log the retry attempt
      db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
        task.id, 'info', `Retry attempt ${retryAttempt}/${task.max_retries} (previous failure: ${failureReason})`
      )

      // Register new agent and transition task to in_progress
      void handleSpawnWorker(db, task.id, newAgentId, { cwd: retryCwd }).then(result => {
        if (!result.ok) {
          console.error(`[spawner] Failed to register retry worker for task ${task.id}: ${result.error}`)
          // Keep retry_count at retryAttempt (already written) so the next retry key
          // advances. Reverting to task.retry_count caused infinite loops because the
          // retried set was cleared while retry_count stayed at 0.
          updateTask(db, task.id, { status: 'failed' })
          retried.delete(retryKey)
        }
      })
    }

    const agents = db.prepare(
      "SELECT * FROM agents WHERE status = 'spawning'"
    ).all() as AgentRow[]

    for (const agent of agents) {
      if (launched.has(agent.id)) continue  // already launched this agent
      if (!agent.cwd) continue              // no working directory — skip
      if (!agent.task_id) continue          // no task — skip

      const task = getTask(db, agent.task_id)
      if (!task) continue

      launched.add(agent.id)

      // Ensure the working directory exists — the first task in a DAG is often
      // a scaffold task that creates the project dir, but spawn fails with ENOENT
      // if the cwd doesn't exist before the process starts.
      mkdirSync(agent.cwd, { recursive: true })

      const spawnCfg = {
        taskId: task.id,
        taskTitle: task.title,
        taskDescription: task.description ?? undefined,
        model: task.model,
        effort: task.effort ?? undefined,
        agentId: agent.id,
        worktreePath: agent.cwd,
        mcpConfigPath,
        openTerminals,
      }

      let handle
      try {
        handle = backend.launch(spawnCfg)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[spawner] Failed to launch worker ${agent.id}: ${msg}`)
        const failureReason = classifyLaunchError(msg)
        updateAgent(db, agent.id, { status: 'failed', failure_reason: failureReason, failure_detail: msg })
        if (agent.task_id) {
          const t = getTask(db, agent.task_id)
          if (t && t.status !== 'done') {
            updateTask(db, agent.task_id, { status: 'failed', failure_reason: failureReason, failure_detail: msg })
          }
          db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
            agent.task_id, 'error', `${failureReason}: ${msg}`
          )
        }
        continue
      }

      if (handle.pid !== undefined) {
        updateAgent(db, agent.id, { pid: handle.pid })
      }
      if (handle.tmuxPane !== undefined) {
        updateAgent(db, agent.id, { tmux_pane: handle.tmuxPane })
      }

      // For tmux workers: verify the agent process actually started inside the pane.
      // The pane shell sends keys but Enter may not land; the pid recorded above is
      // the pane's shell, not claude. Poll asynchronously so we don't block the
      // event loop. If no child process appears within ~4s the agent never started.
      if (handle.tmuxPane !== undefined && handle.pid !== undefined) {
        const panePid = handle.pid
        const capturedAgentId = agent.id
        const capturedTaskId = agent.task_id!
        const capturedPane = handle.tmuxPane

        let verifyAttempts = 0
        const maxVerifyAttempts = 5
        const verifyIntervalMs = 800

        const verifyAgentStarted = () => {
          // If the agent has already exited or been marked (by onExit/onError), stop.
          const agentRow = db.prepare('SELECT status FROM agents WHERE id = ?')
            .get(capturedAgentId) as { status: string } | undefined
          if (agentRow?.status !== 'spawning') return

          const childPid = getChildProcessPid(panePid)

          if (childPid !== undefined) {
            // Agent process found — record the actual agent pid, not the shell
            updateAgent(db, capturedAgentId, { pid: childPid })
            return
          }

          verifyAttempts++
          if (verifyAttempts < maxVerifyAttempts) {
            setTimeout(verifyAgentStarted, verifyIntervalMs)
            return
          }

          // All attempts exhausted — agent process never started
          const current = db.prepare('SELECT status FROM agents WHERE id = ?')
            .get(capturedAgentId) as { status: string } | undefined
          if (current?.status !== 'spawning') return  // already handled

          console.warn(`[spawner] ${AGENT_NEVER_STARTED_REASON} for agent ${capturedAgentId}`)
          updateAgent(db, capturedAgentId, { status: 'failed' })
          const t = getTask(db, capturedTaskId)
          if (t && t.status !== 'done' && t.status !== 'failed') {
            updateTask(db, capturedTaskId, { status: 'failed' })
          }
          db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
            capturedTaskId, 'error', AGENT_NEVER_STARTED_REASON
          )
          killTmuxWindow(capturedPane)
        }

        // Give the tmux send-keys a moment to execute before first check
        setTimeout(verifyAgentStarted, 2000)
      }

      if (openTerminals) {
        openWorkerTerminal(agent.id, workerLogPath(agent.id))
      }

      handle.onError((err) => {
        const msg = err.message
        console.error(`[spawner] Failed to launch worker ${agent.id}: ${msg}`)
        const failureReason = classifyLaunchError(msg)
        updateAgent(db, agent.id, { status: 'failed', failure_reason: failureReason, failure_detail: msg })
        if (agent.task_id) {
          const t = getTask(db, agent.task_id)
          if (t && t.status !== 'done') {
            updateTask(db, agent.task_id, { status: 'failed', failure_reason: failureReason, failure_detail: msg })
          }
          db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
            agent.task_id, 'error', `${failureReason}: ${msg}`
          )
        }
      })

      handle.onExit(() => {
        const current = db.prepare(
          "SELECT status FROM agents WHERE id = ?"
        ).get(agent.id) as { status: string } | undefined
        if (current?.status === 'running' || current?.status === 'spawning') {
          updateAgent(db, agent.id, { status: 'failed' })
          if (agent.task_id) {
            const t = getTask(db, agent.task_id)
            if (t && t.status !== 'done') {
              updateTask(db, agent.task_id, { status: 'failed' })
            }
          }
        }
        // Reap the tmux window (worker has exited; window may linger as a dead pane)
        if (handle.tmuxPane) killTmuxWindow(handle.tmuxPane)
        if (agent.task_id) {
          const logPath = workerLogPath(agent.id)
          const tokens = parseTokensFromLog(logPath)
          if (tokens.total_tokens !== undefined) {
            updateTask(db, agent.task_id, tokens)
          }
          // Surface any CLI stderr warnings (non-JSON lines) to the task log
          // so issues like invalid flags are visible without reading the log file.
          const warnings = parseCliWarnings(logPath)
          for (const warning of warnings) {
            db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(
              agent.task_id, 'warn', `[claude-cli] ${warning}`
            )
          }
        }
      })
    }
  }, 1000)

  // Stuck worker detection — runs every 60 seconds.
  // Warns at stuckWarningMinutes, times out at stuckTimeoutMinutes.
  // Also reaps orphaned tmux windows for tasks already in terminal states.
  const stuckSince = new Map<string, number>()
  setInterval(() => {
    checkStuckWorkers(db, stuckSince, stuckWarningMinutes, stuckTimeoutMinutes)
    if (effectiveRuntime === 'tmux') {
      reapOrphanWindows(db)
    }
  }, 60_000)
}

async function main() {
  const args = process.argv.slice(2)
  const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : 'start'

  if (subcommand === 'init') {
    const useCursor = args.includes('--cursor')
    const useClaude = args.includes('--claude')
    if (useCursor && useClaude) {
      console.error('Error: --cursor and --claude are mutually exclusive.')
      process.exit(1)
    }
    const runtime = useCursor ? 'cursor' : 'claude'
    runInit({ projectDir: process.cwd(), runtime })
    return
  }

  // --- start (default) ---
  const noTui = args.includes('--no-tui')
  const noWeb = args.includes('--no-web')
  const openTerminals = args.includes('--open-terminals')
  const coordPortArg = args.find(a => a.startsWith('--coord-port='))
  const webPortArg = args.find(a => a.startsWith('--web-port='))
  const coordPort = coordPortArg ? parseInt(coordPortArg.split('=')[1]) : 7432
  const webPort = webPortArg ? parseInt(webPortArg.split('=')[1]) : 7433

  const workerRuntimeArg = args.find(a => a.startsWith('--worker-runtime='))
  const workerRuntimeFlag = workerRuntimeArg
    ? (workerRuntimeArg.split('=')[1] as WorkerRuntime)
    : null
  const validRuntimes: WorkerRuntime[] = ['claude', 'cursor', 'tmux']
  if (workerRuntimeFlag && !validRuntimes.includes(workerRuntimeFlag)) {
    console.error(`Error: --worker-runtime must be one of ${validRuntimes.map(r => `"${r}"`).join(', ')}, got "${workerRuntimeFlag}"`)
    process.exit(1)
  }

  const reset = args.includes('--reset')
  if (reset) {
    const dbPath = join(process.cwd(), 'multiclaude.db')
    for (const f of [dbPath, dbPath + '-shm', dbPath + '-wal']) {
      if (existsSync(f)) rmSync(f)
    }
    console.log('Database reset.')
  }

  // Read .multiclaude.json config early so we can route workers correctly.
  // --worker-runtime flag takes precedence over config file.
  const multiclaudeConfig = readConfig(process.cwd())
  const effectiveRuntime: WorkerRuntime = workerRuntimeFlag ?? multiclaudeConfig?.workerRuntime ?? 'claude'

  console.log('Starting MultiClaude...')

  const { db, port } = await startCoordServer({ port: coordPort })
  console.log(`Coordination server: http://localhost:${port}`)

  const mcpConfigPath = writeWorkerMcpConfig(port)

  // Start watcher: polls DB for spawning agents and launches worker subprocesses
  const backend = createBackend(effectiveRuntime, { serverPort: port })
  startSpawnerWatcher(
    db, mcpConfigPath, backend, openTerminals,
    multiclaudeConfig?.stuckWarningMinutes ?? 10,
    multiclaudeConfig?.stuckTimeoutMinutes ?? 30,
  )

  // Register multiclaude-coord in Claude Code's user config via `claude mcp add`.
  // Claude Code stores user-level MCP servers in ~/.claude.json — using the CLI
  // ensures the correct format regardless of Claude Code version.
  const mcpUrl = `http://localhost:${port}/orchestrator`
  try {
    // Remove stale entry first (ignore errors if it doesn't exist)
    execSync('claude mcp remove multiclaude-coord', { stdio: 'pipe' })
  } catch { /* not found — that's fine */ }
  try {
    execSync(`claude mcp add -t http -s user multiclaude-coord ${mcpUrl}`, { stdio: 'pipe' })
    console.log(`MCP server registered: multiclaude-coord → ${mcpUrl}`)
  } catch (e) {
    console.warn(`Warning: could not register MCP server automatically.`)
    console.warn(`Run manually: claude mcp add -t http -s user multiclaude-coord ${mcpUrl}`)
  }

  // Allow all multiclaude-coord MCP tools in ~/.claude/settings.json so Claude
  // Code doesn't prompt for approval on every spawn_worker / complete_task call.
  const mcpTools = [
    'mcp__multiclaude-coord__cancel_task',
    'mcp__multiclaude-coord__complete_task',
    'mcp__multiclaude-coord__create_run',
    'mcp__multiclaude-coord__get_system_status',
    'mcp__multiclaude-coord__list_projects',
    'mcp__multiclaude-coord__list_runs',
    'mcp__multiclaude-coord__plan_dag',
    'mcp__multiclaude-coord__spawn_worker',
    'mcp__multiclaude-coord__wait_for_event',
  ]
  const settingsPath = join(process.env.HOME ?? '~', '.claude', 'settings.json')
  try {
    let settings: { permissions?: { allow?: string[] } } = {}
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')) } catch { /* missing or invalid */ }
    settings.permissions ??= {}
    settings.permissions.allow ??= []
    const added = mcpTools.filter(t => !settings.permissions!.allow!.includes(t))
    if (added.length > 0) {
      settings.permissions.allow.push(...added)
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
      console.log(`Allowed multiclaude-coord tools in ${settingsPath}`)
    }
  } catch (e) {
    console.warn(`Warning: could not update ${settingsPath} — you may be prompted to approve MCP tool calls.`)
  }

  // --- Cursor IDE config ---

  // (1) Merge multiclaude-coord into ~/.cursor/mcp.json
  const cursorDir = join(process.env.HOME ?? '~', '.cursor')
  const cursorMcpPath = join(cursorDir, 'mcp.json')
  try {
    mkdirSync(cursorDir, { recursive: true })
    let cursorMcp: { mcpServers?: Record<string, unknown> } = {}
    try { cursorMcp = JSON.parse(readFileSync(cursorMcpPath, 'utf8')) } catch { /* missing or invalid */ }
    cursorMcp.mcpServers ??= {}
    cursorMcp.mcpServers['multiclaude-coord'] = { url: mcpUrl, type: 'http' }
    writeFileSync(cursorMcpPath, JSON.stringify(cursorMcp, null, 2) + '\n')
    console.log(`Cursor MCP registered: multiclaude-coord → ${mcpUrl} (${cursorMcpPath})`)
  } catch (e) {
    console.warn(`Warning: could not update ${cursorMcpPath} — configure Cursor MCP manually.`)
  }

  // (2) Merge tool allow-lists into ~/.cursor/cli-config.json
  // Always allow orchestrator tools; also allow worker tools when workerRuntime is 'cursor'
  const cursorCoordTools = [
    'mcp__multiclaude-coord__cancel_task',
    'mcp__multiclaude-coord__complete_task',
    'mcp__multiclaude-coord__create_run',
    'mcp__multiclaude-coord__get_system_status',
    'mcp__multiclaude-coord__list_projects',
    'mcp__multiclaude-coord__list_runs',
    'mcp__multiclaude-coord__plan_dag',
    'mcp__multiclaude-coord__spawn_worker',
    'mcp__multiclaude-coord__wait_for_event',
  ]
  const cursorWorkerTools = [
    'mcp__multiclaude-worker__get_my_task',
    'mcp__multiclaude-worker__report_progress',
    'mcp__multiclaude-worker__report_done',
    'mcp__multiclaude-worker__report_blocked',
  ]
  const cursorSettingsPath = join(cursorDir, 'cli-config.json')
  try {
    let cursorSettings: { permissions?: { allow?: string[] } } = {}
    try { cursorSettings = JSON.parse(readFileSync(cursorSettingsPath, 'utf8')) } catch { /* missing or invalid */ }
    cursorSettings.permissions ??= {}
    cursorSettings.permissions.allow ??= []
    const toolsToAdd = effectiveRuntime === 'cursor'
      ? [...cursorCoordTools, ...cursorWorkerTools]
      : cursorCoordTools
    const added = toolsToAdd.filter(t => !cursorSettings.permissions!.allow!.includes(t))
    if (added.length > 0) {
      cursorSettings.permissions.allow.push(...added)
      writeFileSync(cursorSettingsPath, JSON.stringify(cursorSettings, null, 2) + '\n')
      const label = effectiveRuntime === 'cursor' ? 'multiclaude-coord + multiclaude-worker' : 'multiclaude-coord'
      console.log(`Allowed ${label} tools in ${cursorSettingsPath}`)
    }
  } catch (e) {
    console.warn(`Warning: could not update ${cursorSettingsPath} — you may be prompted to approve MCP tool calls in Cursor.`)
  }

  if (!noWeb) {
    startWebServer(db, webPort)
    console.log(`Web dashboard: http://localhost:${webPort}`)
  }

  console.log(`\nMultiClaude running!`)
  console.log(`  Worker runtime:     ${effectiveRuntime}`)
  console.log(`  Terminal windows:   ${openTerminals ? 'enabled (--open-terminals)' : 'disabled (pass --open-terminals to enable)'}`)
  console.log(`  Connect a project:  multiclaude init   (run from your project directory)`)
  console.log(`  Then just run:      ${effectiveRuntime === 'cursor' ? 'cursor' : 'claude'}`)
  console.log(`\nNote: ports ${coordPort} (coord) and ${webPort} (web) are reserved — avoid killing them in agent tasks.\n`)

  if (!noTui) {
    startTui(db)
  } else {
    console.log('MultiClaude running. Press Ctrl+C to stop.')
  }
}

// Catch any unhandled rejections/exceptions so the server never silently dies
process.on('uncaughtException', (err) => {
  console.error('[MultiClaude] Uncaught exception (server kept alive):', err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('[MultiClaude] Unhandled rejection (server kept alive):', reason)
})

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
