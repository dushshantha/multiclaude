import { startCoordServer } from './server/index.js'
import { startWebServer } from './web/server.js'
import { startTui } from './tui/index.js'
import { spawnWorker, writeWorkerMcpConfig } from './spawner/index.js'
import { getTask } from './server/state/tasks.js'
import { updateAgent } from './server/state/agents.js'
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '.'
  const claudeDir = join(homeDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  const orchestratorConfigPath = join(claudeDir, 'multiclaude-orchestrator-mcp.json')
  const orchestratorConfig = {
    mcpServers: {
      'multiclaude-coord': {
        type: 'http',
        url: `http://localhost:${port}/orchestrator`,
      }
    }
  }
  writeFileSync(orchestratorConfigPath, JSON.stringify(orchestratorConfig, null, 2))

  if (!noWeb) {
    startWebServer(db, webPort)
    console.log(`Web dashboard: http://localhost:${webPort}`)
  }

  // Write orchestrator CLAUDE.md to a dedicated session directory.
  // Running `claude` from this directory ensures the orchestrator prompt is loaded
  // as CLAUDE.md context, which overrides global skills (brainstorming etc.).
  const orchSessionDir = join(homeDir, '.claude', 'multiclaude-orchestrator-session')
  mkdirSync(orchSessionDir, { recursive: true })
  const orchestratorPromptPath = join(__dirname, '..', 'prompts', 'orchestrator.md')
  if (existsSync(orchestratorPromptPath)) {
    const prompt = readFileSync(orchestratorPromptPath, 'utf-8')
    writeFileSync(join(orchSessionDir, 'CLAUDE.md'), prompt)
  }

  console.log(`\nTo launch the orchestrator:`)
  console.log(`  cd ${orchSessionDir} && claude --mcp-config ${orchestratorConfigPath}`)
  console.log(`\nNote: ports ${coordPort} (coord) and ${webPort} (web) are reserved — avoid killing them in agent tasks.\n`)

  if (!noTui) {
    startTui(db)
  } else {
    console.log('MultiClaude running. Press Ctrl+C to stop.')
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
