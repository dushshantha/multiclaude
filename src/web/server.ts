import express from 'express'
import { join } from 'path'
import { fileURLToPath } from 'url'
import type Database from 'better-sqlite3'
import { listTasks } from '../server/state/tasks.js'
import { listAgents } from '../server/state/agents.js'
import { listProjects, getProject } from '../server/state/projects.js'
import { listRunsWithStats, getRun } from '../server/state/runs.js'
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
  const projects = listProjects(db)
  return {
    tasks,
    agents,
    edges: db.prepare('SELECT * FROM dag_edges').all(),
    logsByTask,
    agentLogPaths,
    projects,
  }
}

export function startWebServer(db: Database.Database, port = 3000): void {
  const app = express()

  // API routes first (before static middleware)
  app.get('/api/status', (_req, res) => {
    res.json(getSnapshot(db))
  })

  app.get('/api/projects', (_req, res) => {
    res.json(listProjects(db))
  })

  app.get('/api/projects/:id', (req, res) => {
    const project = getProject(db, req.params['id'])
    if (!project) { res.status(404).json({ error: 'Not found' }); return }
    const runs = listRunsWithStats(db, project.id)
    res.json({ project, runs })
  })

  app.get('/api/runs/:id', (req, res) => {
    const run = getRun(db, req.params['id'])
    if (!run) { res.status(404).json({ error: 'Not found' }); return }
    const tasks = listTasks(db).filter(t => (t as any).run_id === run.id)
    const taskIds = tasks.map(t => t.id)
    const edges = taskIds.length > 0
      ? db.prepare(`SELECT from_task, to_task FROM dag_edges WHERE from_task IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds as string[])
      : []
    res.json({ run, tasks, edges })
  })

  app.get('/api/runs/:id/tasks', (req, res) => {
    const run = getRun(db, req.params['id'])
    if (!run) { res.status(404).json({ error: 'Not found' }); return }
    const tasks = listTasks(db).filter(t => (t as any).run_id === run.id)
    res.json(tasks)
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

  // Live log streaming: GET /api/logs/stream?task_id=<id>
  app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const taskId = req.query['task_id'] as string | undefined

    // Send all existing logs as the initial batch
    const existing: LogEntry[] = taskId
      ? db.prepare('SELECT * FROM logs WHERE task_id = ? ORDER BY id ASC').all(taskId) as LogEntry[]
      : db.prepare('SELECT * FROM logs ORDER BY id ASC').all() as LogEntry[]

    let lastId = 0
    if (existing.length > 0) {
      res.write(`data: ${JSON.stringify(existing)}\n\n`)
      lastId = existing[existing.length - 1].id
    } else {
      res.write(`data: []\n\n`)
    }

    // Poll for new entries every 500ms
    const interval = setInterval(() => {
      const newLogs: LogEntry[] = taskId
        ? db.prepare('SELECT * FROM logs WHERE task_id = ? AND id > ? ORDER BY id ASC').all(taskId, lastId) as LogEntry[]
        : db.prepare('SELECT * FROM logs WHERE id > ? ORDER BY id ASC').all(lastId) as LogEntry[]

      if (newLogs.length > 0) {
        res.write(`data: ${JSON.stringify(newLogs)}\n\n`)
        lastId = newLogs[newLogs.length - 1].id
      }
    }, 500)

    req.on('close', () => clearInterval(interval))
  })

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const runIdFilter = req.query['run_id'] as string | undefined

    const send = () => {
      const snapshot = getSnapshot(db)
      if (runIdFilter) {
        const filtered = { ...snapshot, tasks: snapshot.tasks.filter((t: any) => t.run_id === runIdFilter) }
        res.write(`data: ${JSON.stringify(filtered)}\n\n`)
      } else {
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
      }
    }

    send()
    const interval = setInterval(send, 1000)
    req.on('close', () => clearInterval(interval))
  })

  // Page routes — serve HTML files from public/
  app.get('/', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'))
  })

  app.get('/tasks', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'tasks.html'))
  })

  app.get('/projects/:id', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'project.html'))
  })

  app.get('/runs/:id', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'run.html'))
  })

  // Static files (CSS, JS, etc.) — after named routes
  app.use(express.static(join(__dirname, 'public')))

  app.listen(port, () => {
    console.log(`MultiClaude Web UI: http://localhost:${port}`)
  })
}
