import express from 'express'
import { join } from 'path'
import { fileURLToPath } from 'url'
import type Database from 'better-sqlite3'
import { listTasks } from '../server/state/tasks.js'
import { listAgents } from '../server/state/agents.js'
import { workerLogPath } from '../spawner/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

interface LogEntry {
  id: number
  task_id: string | null
  agent_id: string | null
  level: string
  message: string
  created_at: string
}

function getSnapshot(db: Database.Database) {
  const tasks = listTasks(db)
  const agents = listAgents(db)
  // Include last 5 log entries per task so the dashboard can show activity
  const recentLogs = db.prepare(
    'SELECT * FROM logs ORDER BY id DESC LIMIT 100'
  ).all() as LogEntry[]
  // Group by task_id, keep last 5 per task
  const logsByTask: Record<string, LogEntry[]> = {}
  for (const log of recentLogs) {
    const key = log.task_id ?? '__global'
    if (!logsByTask[key]) logsByTask[key] = []
    if (logsByTask[key].length < 5) logsByTask[key].push(log)
  }
  // Add log file paths for agents that have been spawned
  const agentLogPaths: Record<string, string> = {}
  for (const agent of agents) {
    agentLogPaths[agent.id] = workerLogPath(agent.id)
  }
  return {
    tasks,
    agents,
    edges: db.prepare('SELECT * FROM dag_edges').all(),
    logsByTask,
    agentLogPaths,
  }
}

export function startWebServer(db: Database.Database, port = 3000): void {
  const app = express()
  app.use(express.static(join(__dirname, 'public')))

  app.get('/api/status', (_req, res) => {
    res.json(getSnapshot(db))
  })

  // Logs endpoint: GET /api/logs?task_id=<id>&limit=<n>
  app.get('/api/logs', (req, res) => {
    const taskId = req.query['task_id'] as string | undefined
    const limit = Math.min(parseInt((req.query['limit'] as string) || '100', 10), 500)
    let rows: LogEntry[]
    if (taskId) {
      rows = db.prepare(
        'SELECT * FROM logs WHERE task_id = ? ORDER BY id DESC LIMIT ?'
      ).all(taskId, limit) as LogEntry[]
    } else {
      rows = db.prepare(
        'SELECT * FROM logs ORDER BY id DESC LIMIT ?'
      ).all(limit) as LogEntry[]
    }
    res.json(rows.reverse())
  })

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const send = () => {
      res.write(`data: ${JSON.stringify(getSnapshot(db))}\n\n`)
    }

    send()
    const interval = setInterval(send, 1000)
    req.on('close', () => clearInterval(interval))
  })

  app.listen(port, () => {
    console.log(`MultiClaude Web UI: http://localhost:${port}`)
  })
}
