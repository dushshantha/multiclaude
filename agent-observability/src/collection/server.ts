import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Db } from '../db/index.js'
import { createSession, updateSession } from '../sessions/index.js'
import { getOrgBySlug } from '../orgs/index.js'
import { upsertDeveloper } from '../developers/index.js'

// In-memory token store: token -> { orgId, orgSlug, developerId?, expiresAt }
const tokenStore = new Map<string, { orgId: string; orgSlug: string; developerId?: string; expiresAt: number }>()

/**
 * Creates a simple localhost OAuth provider backed by an in-memory token store.
 * Tokens are issued for org slugs and verified on each request.
 */
export function createLocalhostOAuthProvider(db: Db) {
  return {
    /**
     * Issues a token for the given org slug and optional user email.
     * If email is provided, upserts the developer record and ties the token to that developer.
     */
    async issueToken(orgSlug: string, email?: string, name?: string): Promise<string> {
      const org = await getOrgBySlug(db, orgSlug)
      if (!org) throw new Error(`Org not found: ${orgSlug}`)
      let developerId: string | undefined
      if (email) {
        const developer = await upsertDeveloper(db, org.id, email, name)
        developerId = developer.id
      }
      const token = randomUUID()
      tokenStore.set(token, {
        orgId: org.id,
        orgSlug: org.slug,
        developerId,
        expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 365, // 1 year
      })
      return token
    },

    /**
     * Verifies a bearer token and returns org context (including developerId if present), or null if invalid.
     */
    verifyToken(token: string): { orgId: string; orgSlug: string; developerId?: string } | null {
      const entry = tokenStore.get(token)
      if (!entry) return null
      if (Date.now() > entry.expiresAt) {
        tokenStore.delete(token)
        return null
      }
      return { orgId: entry.orgId, orgSlug: entry.orgSlug, developerId: entry.developerId }
    },

    /**
     * Revokes a token.
     */
    revokeToken(token: string): void {
      tokenStore.delete(token)
    },
  }
}

export type LocalhostOAuthProvider = ReturnType<typeof createLocalhostOAuthProvider>

/**
 * Creates an MCP server for an org with tools to report session telemetry.
 * If developerId is provided (from the auth token), it is used as the default developer for new sessions.
 */
export function createOrgMcp(db: Db, orgId: string, developerId?: string): McpServer {
  const mcp = new McpServer({ name: 'agent-observability', version: '1.0.0' })

  mcp.registerTool(
    'register_developer',
    {
      description: 'Register or look up a developer by email. Returns a stable developer ID that can be used in subsequent report_session_start calls.',
      inputSchema: z.object({
        email: z.string().email(),
        name: z.string().optional(),
      }),
    },
    async (args) => {
      const developer = await upsertDeveloper(db, orgId, args.email, args.name)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ developerId: developer.id, email: developer.email, name: developer.name }) }],
      }
    }
  )

  mcp.registerTool(
    'report_session_start',
    {
      description: 'Report the start of a Claude Code session',
      inputSchema: z.object({
        gitBranch: z.string().optional(),
        gitRepo: z.string().optional(),
        workingDir: z.string().optional(),
        taskDescription: z.string().optional(),
        developerId: z.string().optional(),
        developerEmail: z.string().email().optional(),
      }),
    },
    async (args) => {
      let resolvedDeveloperId = args.developerId
      if (!resolvedDeveloperId && args.developerEmail) {
        const developer = await upsertDeveloper(db, orgId, args.developerEmail)
        resolvedDeveloperId = developer.id
      }
      // Fall back to the developer captured at token-issuance time (OAuth flow)
      if (!resolvedDeveloperId && developerId) {
        resolvedDeveloperId = developerId
      }
      const session = await createSession(db, {
        orgId,
        gitBranch: args.gitBranch,
        gitRepo: args.gitRepo,
        workingDir: args.workingDir,
        taskDescription: args.taskDescription,
        developerId: resolvedDeveloperId,
      })
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ sessionId: session.id }) }],
      }
    }
  )

  mcp.registerTool(
    'report_cost',
    {
      description: 'Report token usage and cost for a session',
      inputSchema: z.object({
        sessionId: z.string(),
        tokensIn: z.number().int().nonnegative(),
        tokensOut: z.number().int().nonnegative(),
        costUsd: z.string(),
      }),
    },
    async (args) => {
      const session = await updateSession(db, args.sessionId, {
        tokensIn: args.tokensIn,
        tokensOut: args.tokensOut,
        costUsd: args.costUsd,
      })
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, sessionId: session?.id }) }],
      }
    }
  )

  mcp.registerTool(
    'report_task_complete',
    {
      description: 'Report that a task session has completed',
      inputSchema: z.object({
        sessionId: z.string(),
        durationSecs: z.number().int().nonnegative().optional(),
        tokensIn: z.number().int().nonnegative().optional(),
        tokensOut: z.number().int().nonnegative().optional(),
        costUsd: z.string().optional(),
      }),
    },
    async (args) => {
      const session = await updateSession(db, args.sessionId, {
        endedAt: new Date(),
        durationSecs: args.durationSecs,
        tokensIn: args.tokensIn,
        tokensOut: args.tokensOut,
        costUsd: args.costUsd,
      })
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, sessionId: session?.id }) }],
      }
    }
  )

  return mcp
}

/**
 * Creates a multi-tenant Express server that handles MCP connections via StreamableHTTP.
 * Each request is authenticated via a bearer token that maps to an org.
 * Returns { server, port } once the server is listening.
 */
export async function createCollectionServer(db: Db): Promise<{ server: Server; port: number }> {
  const oauthProvider = createLocalhostOAuthProvider(db)
  const app = express()
  app.use(express.json())

  // POST /auth/register — issue a token for a developer.
  // Body: { orgSlug: string, email: string, name?: string }
  // Returns: { token: string, developerId: string }
  app.post('/auth/register', async (req, res) => {
    const { orgSlug, email, name } = req.body ?? {}
    if (!orgSlug || typeof orgSlug !== 'string') {
      res.status(400).json({ error: 'orgSlug is required' })
      return
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({ error: 'A valid email is required' })
      return
    }
    try {
      const token = await oauthProvider.issueToken(orgSlug, email, name ?? undefined)
      const orgCtx = oauthProvider.verifyToken(token)!
      res.json({ token, developerId: orgCtx.developerId })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(400).json({ error: message })
    }
  })

  // Active transports per session
  const transports = new Map<string, StreamableHTTPServerTransport>()

  app.all('/mcp', async (req, res) => {
    // Extract bearer token for org resolution
    const authHeader = req.headers.authorization ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    const orgCtx = oauthProvider.verifyToken(token)

    if (!orgCtx) {
      res.status(401).json({ error: 'Unauthorized: invalid or missing token' })
      return
    }

    // Reuse existing transport for this session if present
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    let transport: StreamableHTTPServerTransport

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!
    } else if (req.method === 'POST' && !sessionId) {
      // New session initialization
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      })

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId)
        }
      }

      const mcp = createOrgMcp(db, orgCtx.orgId, orgCtx.developerId)
      await mcp.connect(transport)

      if (transport.sessionId) {
        transports.set(transport.sessionId, transport)
      }
    } else {
      res.status(400).json({ error: 'Bad request: missing or invalid session' })
      return
    }

    await transport.handleRequest(req, res, req.body)
  })

  const server = createServer(app)

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

  return { server, port }
}
