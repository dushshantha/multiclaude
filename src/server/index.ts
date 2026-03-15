import express from 'express'
import { createServer } from 'http'
import { randomUUID } from 'crypto'
import { createDb } from './state/db.js'
import { handlePlanDag, handleGetSystemStatus, handleWaitForEvent, handleCancelTask, handleSpawnWorker, handleCompleteTask, handleCreateRun, handleListProjects, handleListRuns } from './tools/orchestrator.js'
import { backfillProjectsFromAgents } from './state/projects.js'
import { handleGetMyTask, handleReportProgress, handleReportDone, handleReportBlocked } from './tools/worker.js'
import type Database from 'better-sqlite3'
import type { Server } from 'http'
import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'

export interface CoordServerOptions {
  port?: number
  dbPath?: string
}

// Minimal in-memory OAuth provider for localhost.
// Auto-approves all client registrations, authorizations, and token requests.
// Suitable for local development only — do not expose to the internet.
function createLocalhostOAuthProvider(): OAuthServerProvider {
  const clients = new Map<string, OAuthClientInformationFull>()
  const codes = new Map<string, string>() // authCode -> codeChallenge

  const clientsStore: OAuthRegisteredClientsStore = {
    getClient(clientId: string) {
      return clients.get(clientId)
    },
    registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) {
      const full: OAuthClientInformationFull = {
        ...client,
        client_id: randomUUID(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
      }
      clients.set(full.client_id, full)
      return full
    },
  }

  return {
    clientsStore,

    // Auto-approve: immediately redirect back with an authorization code.
    async authorize(client, params, res) {
      const code = randomUUID()
      codes.set(code, params.codeChallenge)
      const redirectUrl = new URL(params.redirectUri)
      redirectUrl.searchParams.set('code', code)
      if (params.state) redirectUrl.searchParams.set('state', params.state)
      res.redirect(302, redirectUrl.href)
    },

    // Return the stored challenge for PKCE validation.
    async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
      const challenge = codes.get(authorizationCode)
      if (!challenge) throw new Error('Unknown authorization code')
      codes.delete(authorizationCode)
      return challenge
    },

    // Issue tokens with 1-year expiry — no revocation needed for localhost.
    async exchangeAuthorizationCode(): Promise<OAuthTokens> {
      return { access_token: randomUUID(), token_type: 'Bearer', expires_in: 365 * 24 * 3600 }
    },

    async exchangeRefreshToken(): Promise<OAuthTokens> {
      return { access_token: randomUUID(), token_type: 'Bearer', expires_in: 365 * 24 * 3600 }
    },

    // Accept any Bearer token — the 401 on first request is sufficient to trigger
    // the OAuth flow; we don't need strict per-token tracking on localhost.
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      return {
        token,
        clientId: 'localhost',
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      }
    },
  }
}

// Factory: create a fresh McpServer with orchestrator tools bound to the given db.
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
          model: z.enum(['haiku', 'sonnet', 'opus']).optional().describe('Model to use for this task (default: sonnet)'),
          dependsOn: z.array(z.string()),
        })),
        run_id: z.string().optional(),
        cwd: z.string().optional().describe('Project directory — pass this to auto-create a run when no run_id is given'),
      })
    },
    async ({ epic }) => {
      const result = handlePlanDag(db, epic)
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: `ERROR: ${result.error}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: result.visualization }] }
    }
  )

  server.tool(
    'get_system_status',
    'Get system status (instant snapshot). By default only returns active tasks (pending/in_progress) to keep responses small. Set include_done=true to also include done/failed tasks. Always includes active_count and done_count totals.',
    { include_done: z.boolean().optional() },
    async ({ include_done }) => {
      const status = handleGetSystemStatus(db, include_done ?? false)
      return { content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }] }
    }
  )

  server.tool(
    'wait_for_event',
    'Block until any task status changes, then return system status. Use this in the monitoring loop instead of repeatedly calling get_system_status — it waits server-side so you don\'t burn context spinning. Polls every 1s for up to timeout_seconds (default 30). By default only returns active tasks; set include_done=true to also see done/failed tasks. Always includes active_count and done_count totals.',
    { timeout_seconds: z.number().optional(), include_done: z.boolean().optional() },
    async ({ timeout_seconds, include_done }) => {
      const status = await handleWaitForEvent(db, timeout_seconds ?? 30, include_done ?? false)
      return { content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }] }
    }
  )

  server.tool(
    'spawn_worker',
    'Register a worker agent for a task. Returns an error if any DAG blockers are not done. Pass cwd (the directory to run the worker in).',
    { task_id: z.string(), agent_id: z.string(), pid: z.number().optional(), cwd: z.string().optional() },
    async ({ task_id, agent_id, pid, cwd }) => {
      const result = await handleSpawnWorker(db, task_id, agent_id, { pid, cwd })
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `ERROR: ${result.error}` }], isError: true }
      }
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

  server.tool(
    'complete_task',
    'Manually mark a task as done. Use only as a recovery measure when a worker completed work but failed to call report_done (e.g. the subprocess crashed). Marks the task and its agent as done.',
    { task_id: z.string(), summary: z.string() },
    async ({ task_id, summary }) => {
      handleCompleteTask(db, task_id, summary)
      return { content: [{ type: 'text' as const, text: `Task ${task_id} marked as done` }] }
    }
  )

  server.tool(
    'create_run',
    'Create a new run (a named grouping of tasks, e.g. for a ticket or feature). Pass cwd (the project directory) to auto-create or look up the project. Returns the run_id to pass to plan_dag.',
    { title: z.string(), cwd: z.string(), external_ref: z.string().optional() },
    async ({ title, cwd, external_ref }) => {
      const result = handleCreateRun(db, title, cwd, external_ref)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    }
  )

  server.tool(
    'list_projects',
    'List all projects with aggregate stats: total/done/failed task counts, run count, and last_active_at.',
    {},
    async () => {
      const projects = handleListProjects(db)
      return { content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }] }
    }
  )

  server.tool(
    'list_runs',
    'List runs, optionally filtered by project_id. Each run includes task counts and a derived_status (open/active/done).',
    { project_id: z.string().optional() },
    async ({ project_id }) => {
      const runs = handleListRuns(db, project_id)
      return { content: [{ type: 'text' as const, text: JSON.stringify(runs, null, 2) }] }
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
    {
      task_id: z.string(),
      summary: z.string(),
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
      duration_seconds: z.number().optional(),
    },
    async ({ task_id, summary, input_tokens, output_tokens, total_tokens, duration_seconds }) => {
      await handleReportDone(db, task_id, summary, { input_tokens, output_tokens, total_tokens, duration_seconds })
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
  backfillProjectsFromAgents(db)
  const app = express()
  // Do NOT add express.json() here — MCP Streamable HTTP transport reads the
  // raw request body itself (and may send ndjson batches that body-parser rejects).

  const issuerUrl = new URL(`http://localhost:${port}`)
  const oauthProvider = createLocalhostOAuthProvider()

  // Mount OAuth endpoints: /.well-known/*, /register, /authorize, /token
  app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl }))

  // Bearer auth middleware — returns 401 + WWW-Authenticate on first unauthenticated
  // request, which triggers Claude Code's automatic OAuth flow.
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    resourceMetadataUrl: `http://localhost:${port}/.well-known/oauth-protected-resource`,
  })

  // Session maps for Streamable HTTP transports (one transport per MCP session).
  const orchestratorSessions = new Map<string, StreamableHTTPServerTransport>()
  const workerSessions = new Map<string, StreamableHTTPServerTransport>()

  // Orchestrator endpoint — Streamable HTTP handles both GET (SSE) and POST.
  app.all('/orchestrator', bearerAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (sessionId) {
      const transport = orchestratorSessions.get(sessionId)
      if (!transport) { res.status(404).json({ error: 'Session not found' }); return }
      await transport.handleRequest(req, res)
      return
    }

    // New session: create transport + McpServer pair.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
    const mcp = createOrchestratorMcp(db)
    await mcp.connect(transport)
    transport.onclose = () => { if (transport.sessionId) orchestratorSessions.delete(transport.sessionId) }
    await transport.handleRequest(req, res)
    if (transport.sessionId) orchestratorSessions.set(transport.sessionId, transport)
  })

  // Worker endpoint — no auth required. Workers are subprocesses spawned on
  // localhost by the CLI; they can't do OAuth in headless mode (no browser/TTY).
  // The orchestrator endpoint keeps auth since it's used by user-facing sessions.
  app.all('/worker', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (sessionId) {
      const transport = workerSessions.get(sessionId)
      if (!transport) { res.status(404).json({ error: 'Session not found' }); return }
      await transport.handleRequest(req, res)
      return
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
    const mcp = createWorkerMcp(db)
    await mcp.connect(transport)
    transport.onclose = () => { if (transport.sessionId) workerSessions.delete(transport.sessionId) }
    await transport.handleRequest(req, res)
    if (transport.sessionId) workerSessions.set(transport.sessionId, transport)
  })

  const httpServer = createServer(app)
  await new Promise<void>(resolve => httpServer.listen(port, resolve))

  return { db, port, httpServer }
}
