import express from 'express'
import { join } from 'path'
import { fileURLToPath } from 'url'
import type Database from 'better-sqlite3'
import { listTasks } from '../server/state/tasks.js'
import { listAgents } from '../server/state/agents.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export function startWebServer(db: Database.Database, port = 3000): void {
  const app = express()
  app.use(express.static(join(__dirname, 'public')))

  app.get('/api/status', (_req, res) => {
    res.json({
      tasks: listTasks(db),
      agents: listAgents(db),
      edges: db.prepare('SELECT * FROM dag_edges').all(),
    })
  })

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const send = () => {
      const data = JSON.stringify({
        tasks: listTasks(db),
        agents: listAgents(db),
        edges: (db.prepare('SELECT * FROM dag_edges').all()),
      })
      res.write(`data: ${data}\n\n`)
    }

    send()
    const interval = setInterval(send, 1000)
    req.on('close', () => clearInterval(interval))
  })

  app.listen(port, () => {
    console.log(`MultiClaude Web UI: http://localhost:${port}`)
  })
}
