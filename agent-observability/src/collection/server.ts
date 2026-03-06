import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { eq, and, gt } from 'drizzle-orm'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Db } from '../db/index.js'
import { tokens } from '../db/schema.js'
import { createSession, updateSession } from '../sessions/index.js'
import { getOrgBySlug } from '../orgs/index.js'
import { upsertDeveloper } from '../developers/index.js'

/**
 * Creates a simple localhost OAuth provider backed by a PostgreSQL tokens table.
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
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365) // 1 year
      await db.insert(tokens).values({
        orgId: org.id,
        developerId: developerId ?? null,
        token,
        expiresAt,
      })
      return token
    },

    /**
     * Verifies a bearer token and returns org context (including developerId if present), or null if invalid.
     */
    async verifyToken(token: string): Promise<{ orgId: string; orgSlug: string; developerId?: string } | null> {
      const now = new Date()
      const rows = await db
        .select({ orgId: tokens.orgId, developerId: tokens.developerId, expiresAt: tokens.expiresAt })
        .from(tokens)
        .where(eq(tokens.token, token))
      const row = rows[0]
      if (!row) return null
      if (now > row.expiresAt) {
        await db.delete(tokens).where(eq(tokens.token, token))
        return null
      }
      const org = await db.query.orgs.findFirst({ where: (o, { eq: eqFn }) => eqFn(o.id, row.orgId) })
      if (!org) return null
      return { orgId: row.orgId, orgSlug: org.slug, developerId: row.developerId ?? undefined }
    },

    /**
     * Revokes a token.
     */
    async revokeToken(token: string): Promise<void> {
      await db.delete(tokens).where(eq(tokens.token, token))
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

function renderLoginForm(params: {
  redirect_uri: string
  state?: string
  code_challenge?: string
  code_challenge_method?: string
  error?: string
}): string {
  const esc = (v: string | undefined) => (v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Authenticate</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f5f5f5;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.1);
      padding: 2rem;
      width: 100%; max-width: 360px;
    }
    h1 { font-size: 1.25rem; margin: 0 0 1.5rem; color: #111; }
    .error {
      background: #fef2f2; color: #b91c1c;
      border: 1px solid #fecaca; border-radius: 4px;
      padding: 0.625rem 0.875rem;
      margin-bottom: 1rem; font-size: 0.875rem;
    }
    label { display: block; font-size: 0.875rem; color: #374151; margin-bottom: 0.25rem; }
    input[type="text"], input[type="email"] {
      width: 100%; padding: 0.5rem 0.75rem;
      border: 1px solid #d1d5db; border-radius: 4px;
      font-size: 0.95rem; outline: none;
      margin-bottom: 1rem;
    }
    input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.15); }
    button {
      width: 100%; padding: 0.625rem;
      background: #6366f1; color: #fff;
      border: none; border-radius: 4px;
      font-size: 1rem; cursor: pointer;
    }
    button:hover { background: #4f46e5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authenticate</h1>
    ${params.error ? `<div class="error">${esc(params.error)}</div>` : ''}
    <form method="POST" action="/authorize">
      <input type="hidden" name="redirect_uri" value="${esc(params.redirect_uri)}" />
      <input type="hidden" name="state" value="${esc(params.state)}" />
      <input type="hidden" name="code_challenge" value="${esc(params.code_challenge)}" />
      <input type="hidden" name="code_challenge_method" value="${esc(params.code_challenge_method)}" />
      <label for="orgSlug">Org Slug</label>
      <input type="text" id="orgSlug" name="orgSlug" placeholder="your-org" required />
      <label for="email">Email</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" required />
      <button type="submit">Authenticate</button>
    </form>
  </div>
</body>
</html>`
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
  app.use(express.urlencoded({ extended: false }))

  // In-memory stores for the OAuth flow (single-server, local dev only)
  const authCodes = new Map<string, string>()    // code -> bearer token
  const oauthClients = new Map<string, object>() // client_id -> client metadata

  // GET /.well-known/oauth-authorization-server — OAuth 2.0 Authorization Server Metadata (RFC 8414)
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const base = `http://${req.headers.host}`
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    })
  })

  // POST /register — dynamic client registration (RFC 7591)
  // Accepts any client metadata and returns a client_id. Stored in memory only.
  app.post('/register', (req, res) => {
    const clientId = randomUUID()
    const client = { ...req.body, client_id: clientId }
    oauthClients.set(clientId, client)
    res.status(201).json(client)
  })

  // GET /authorize — authorization endpoint
  // Serves an interactive login form asking for orgSlug and email.
  app.get('/authorize', (req, res) => {
    const redirect_uri = req.query['redirect_uri'] as string | undefined
    const state = req.query['state'] as string | undefined
    const code_challenge = req.query['code_challenge'] as string | undefined
    const code_challenge_method = req.query['code_challenge_method'] as string | undefined

    if (!redirect_uri) {
      res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is required' })
      return
    }

    res.send(renderLoginForm({ redirect_uri, state, code_challenge, code_challenge_method }))
  })

  // POST /authorize — handle login form submission
  app.post('/authorize', async (req, res) => {
    const { orgSlug, email, redirect_uri, state, code_challenge, code_challenge_method } = req.body as Record<string, string>

    if (!redirect_uri) {
      res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is required' })
      return
    }

    if (!orgSlug || !email) {
      res.send(renderLoginForm({ redirect_uri, state, code_challenge, code_challenge_method, error: 'Org Slug and Email are required.' }))
      return
    }

    try {
      // Look up the org to get its id
      const org = await getOrgBySlug(db, orgSlug)
      if (!org) {
        res.send(renderLoginForm({ redirect_uri, state, code_challenge, code_challenge_method, error: `Org not found: ${orgSlug}` }))
        return
      }

      // Upsert developer and look for an existing valid token
      const developer = await upsertDeveloper(db, org.id, email)
      const now = new Date()
      const existingRows = await db
        .select({ token: tokens.token })
        .from(tokens)
        .where(and(eq(tokens.developerId, developer.id), gt(tokens.expiresAt, now)))
        .limit(1)

      let token: string
      if (existingRows.length > 0) {
        token = existingRows[0].token
      } else {
        token = await oauthProvider.issueToken(orgSlug, email)
      }

      const code = randomUUID()
      authCodes.set(code, token)

      const redirectUrl = new URL(redirect_uri)
      redirectUrl.searchParams.set('code', code)
      if (state) redirectUrl.searchParams.set('state', state)

      res.redirect(redirectUrl.toString())
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Authentication failed'
      res.send(renderLoginForm({ redirect_uri, state, code_challenge, code_challenge_method, error: message }))
    }
  })

  // POST /token — token endpoint
  // Exchanges an authorization code for the bearer token.
  app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    // Accept both JSON and form-encoded bodies (the middleware above handles urlencoded)
    const body = req.body as Record<string, string>
    const { grant_type, code } = body

    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Only authorization_code is supported' })
      return
    }

    if (!code || !authCodes.has(code)) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' })
      return
    }

    const token = authCodes.get(code)!
    authCodes.delete(code)

    res.json({ access_token: token, token_type: 'Bearer' })
  })

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
      const orgCtx = await oauthProvider.verifyToken(token)
      res.json({ token, developerId: orgCtx?.developerId })
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
    const orgCtx = await oauthProvider.verifyToken(token)

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
  const port = parseInt(process.env.COLLECTION_PORT ?? '7433', 10)

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve)
  })

  const addr = server.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : port

  return { server, port: actualPort }
}
