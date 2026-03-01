#!/usr/bin/env node
import { startCoordServer } from './server/index.js'
import { startWebServer } from './web/server.js'
import { startTui } from './tui/index.js'
import { spawnWorker, writeWorkerMcpConfig } from './spawner/index.js'
import { getTask } from './server/state/tasks.js'
import { updateAgent } from './server/state/agents.js'
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { runInit } from './init.js'
import type Database from 'better-sqlite3'

interface AgentRow {
  id: string
  task_id: string | null
  cwd: string | null
  pid: number | null
  status: string
}

function startSpawnerWatcher(db: Database.Database, mcpConfigPath: string): void {
  const launched = new Set<string>()

  setInterval(() => {
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

      const child = spawnWorker({
        taskId: task.id,
        taskTitle: task.title,
        taskDescription: task.description ?? undefined,
        agentId: agent.id,
        worktreePath: agent.cwd,
        mcpConfigPath,
      })

      if (child.pid !== undefined) {
        updateAgent(db, agent.id, { pid: child.pid })
      }

      child.on('error', (err) => {
        // spawn failed (e.g. 'claude' binary not found) — mark agent failed so
        // the orchestrator can retry instead of waiting forever
        console.error(`[spawner] Failed to launch worker ${agent.id}: ${err.message}`)
        updateAgent(db, agent.id, { status: 'failed' })
      })

      child.on('exit', () => {
        // If worker exited without calling report_done, mark agent as failed
        const current = db.prepare(
          "SELECT status FROM agents WHERE id = ?"
        ).get(agent.id) as { status: string } | undefined
        if (current?.status === 'running' || current?.status === 'spawning') {
          updateAgent(db, agent.id, { status: 'failed' })
        }
      })
    }
  }, 1000)
}

async function main() {
  const args = process.argv.slice(2)
  const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : 'start'

  if (subcommand === 'init') {
    runInit({ projectDir: process.cwd() })
    return
  }

  // --- start (default) ---
  const noTui = args.includes('--no-tui')
  const noWeb = args.includes('--no-web')
  const coordPortArg = args.find(a => a.startsWith('--coord-port='))
  const webPortArg = args.find(a => a.startsWith('--web-port='))
  const coordPort = coordPortArg ? parseInt(coordPortArg.split('=')[1]) : 7432
  const webPort = webPortArg ? parseInt(webPortArg.split('=')[1]) : 7433

  const reset = args.includes('--reset')
  if (reset) {
    const dbPath = join(process.cwd(), 'multiclaude.db')
    for (const f of [dbPath, dbPath + '-shm', dbPath + '-wal']) {
      if (existsSync(f)) rmSync(f)
    }
    console.log('Database reset.')
  }

  console.log('Starting MultiClaude...')

  const { db, port } = await startCoordServer({ port: coordPort })
  console.log(`Coordination server: http://localhost:${port}`)

  const mcpConfigPath = writeWorkerMcpConfig(port)

  // Start watcher: polls DB for spawning agents and launches claude subprocesses
  startSpawnerWatcher(db, mcpConfigPath)

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

  if (!noWeb) {
    startWebServer(db, webPort)
    console.log(`Web dashboard: http://localhost:${webPort}`)
  }

  console.log(`\nMultiClaude running!`)
  console.log(`  Connect a project:  multiclaude init   (run from your project directory)`)
  console.log(`  Then just run:      claude`)
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
