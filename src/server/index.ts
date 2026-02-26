import express from 'express'
import { createServer } from 'http'
import { createDb } from './state/db.js'
import { handlePlanDag, handleGetSystemStatus, handleCancelTask } from './tools/orchestrator.js'
import { handleGetMyTask, handleReportProgress, handleReportDone, handleReportBlocked } from './tools/worker.js'
import { registerAgent } from './state/agents.js'
import { updateTask } from './state/tasks.js'
import type Database from 'better-sqlite3'
import type { Server } from 'http'
import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'

export interface CoordServerOptions {
  port?: number
  dbPath?: string
}

// Factory: create a fresh McpServer with orchestrator tools bound to the given db.
// Must be called per connection — McpServer is stateful and single-connection.
function createOrchestratorMcp(db: Database.Database): McpServer {
  const server = new McpServer({ name: 'multiclaude-orchestrator', version: '1.0.0' })

  server.tool(
    'plan_dag',
    'Decompose epic into tasks with DAG dependencies',
    {
      epic: z.object({
        tasks: z.array(z.object({
          id: z.string(),
          title: z.string(),
          description: z.string().optional(),
          dependsOn: z.array(z.string()),
        }))
      })
    },
    async ({ epic }) => {
      handlePlanDag(db, epic)
      return { content: [{ type: 'text' as const, text: 'DAG created successfully' }] }
    }
  )

  server.tool(
    'get_system_status',
    'Get full system status',
    {},
    async () => {
      const status = handleGetSystemStatus(db)
      return { content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }] }
    }
  )

  server.tool(
    'spawn_worker',
    'Register a worker agent for a task',
    { task_id: z.string(), agent_id: z.string(), pid: z.number().optional() },
    async ({ task_id, agent_id, pid }) => {
      registerAgent(db, { id: agent_id, task_id, pid })
      updateTask(db, task_id, { status: 'in_progress', agent_id })
      return { content: [{ type: 'text' as const, text: `Worker ${agent_id} registered for task ${task_id}` }] }
    }
  )

  server.tool(
    'cancel_task',
    'Cancel a task',
    { task_id: z.string() },
    async ({ task_id }) => {
      handleCancelTask(db, task_id)
      return { content: [{ type: 'text' as const, text: `Task ${task_id} cancelled` }] }
    }
  )

  return server
}

// Factory: create a fresh McpServer with worker tools bound to the given db.
function createWorkerMcp(db: Database.Database): McpServer {
  const server = new McpServer({ name: 'multiclaude-worker', version: '1.0.0' })

  server.tool(
    'get_my_task',
    'Get your assigned task',
    { agent_id: z.string() },
    async ({ agent_id }) => {
      const task = handleGetMyTask(db, agent_id)
      return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] }
    }
  )

  server.tool(
    'report_progress',
    'Send a progress update',
    { agent_id: z.string(), task_id: z.string(), message: z.string() },
    async ({ agent_id, task_id, message }) => {
      handleReportProgress(db, agent_id, task_id, message)
      return { content: [{ type: 'text' as const, text: 'Progress logged' }] }
    }
  )

  server.tool(
    'report_done',
    'Signal task completion',
    { task_id: z.string(), summary: z.string() },
    async ({ task_id, summary }) => {
      handleReportDone(db, task_id, summary)
      return { content: [{ type: 'text' as const, text: 'Task marked as done' }] }
    }
  )

  server.tool(
    'report_blocked',
    'Report a failure and request retry or escalation',
    { task_id: z.string(), reason: z.string(), error_context: z.string() },
    async ({ task_id, reason, error_context }) => {
      const result = handleReportBlocked(db, task_id, reason, error_context)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    }
  )

  return server
}

export async function startCoordServer(opts: CoordServerOptions = {}): Promise<{
  db: Database.Database
  port: number
  httpServer: Server
}> {
  const port = opts.port ?? 7432
  const db = createDb(opts.dbPath ?? './multiclaude.db')
  const app = express()
  app.use(express.json())

  // OAuth protected resource metadata.
  // Returning this endpoint with no authorization_servers tells MCP clients
  // (including Claude Code) that this is a known resource but auth is not enforced,
  // resolving the "not authenticated" probe failure on localhost.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: `http://localhost:${port}`,
      bearer_methods_supported: ['header'],
      scopes_supported: [],
    })
  })

  // SSE transports — keyed by sessionId for message routing.
  const orchestratorTransports: Record<string, SSEServerTransport> = {}
  const workerTransports: Record<string, SSEServerTransport> = {}

  // Orchestrator endpoint — create a fresh McpServer per connection.
  app.get('/orchestrator', async (req, res) => {
    const transport = new SSEServerTransport('/orchestrator/messages', res)
    orchestratorTransports[transport.sessionId] = transport
    res.on('close', () => { delete orchestratorTransports[transport.sessionId] })
    const mcp = createOrchestratorMcp(db)
    await mcp.connect(transport)
  })
  app.post('/orchestrator/messages', async (req, res) => {
    const sessionId = req.query['sessionId'] as string
    const transport = orchestratorTransports[sessionId]
    if (!transport) { res.status(404).json({ error: 'Session not found' }); return }
    await transport.handlePostMessage(req, res)
  })

  // Worker endpoint — create a fresh McpServer per connection.
  app.get('/worker', async (req, res) => {
    const transport = new SSEServerTransport('/worker/messages', res)
    workerTransports[transport.sessionId] = transport
    res.on('close', () => { delete workerTransports[transport.sessionId] })
    const mcp = createWorkerMcp(db)
    await mcp.connect(transport)
  })
  app.post('/worker/messages', async (req, res) => {
    const sessionId = req.query['sessionId'] as string
    const transport = workerTransports[sessionId]
    if (!transport) { res.status(404).json({ error: 'Session not found' }); return }
    await transport.handlePostMessage(req, res)
  })

  const httpServer = createServer(app)
  await new Promise<void>(resolve => httpServer.listen(port, resolve))

  return { db, port, httpServer }
}
