import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { eq, and, gt } from 'drizzle-orm'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { z } from 'zod'
import type { Db } from '../db/index.js'
import { tokens } from '../db/schema.js'
import { createSession, updateSession } from '../sessions/index.js'
import { getOrgBySlug } from '../orgs/index.js'
import { upsertDeveloper } from '../developers/index.js'

/**
 * Verifies a bearer token and returns org context, or null if invalid/expired.
 */
export async function verifyToken(db: Db, token: string): Promise<{ orgId: string; orgSlug: string; developerId?: string } | null> {
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
}

/**
 * Issues a new bearer token for an org/developer and persists it in the DB.
 */
export async function issueToken(db: Db, orgSlug: string, email?: string, name?: string): Promise<string> {
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
}

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
 * OAuth is handled by the MCP SDK's mcpAuthRouter + requireBearerAuth.
 * Returns { server, port } once the server is listening.
 */
export async function createCollectionServer(db: Db): Promise<{ server: Server; port: number }> {
  const port = parseInt(process.env.COLLECTION_PORT ?? '7433', 10)
  const issuerUrl = new URL(`http://127.0.0.1:${port}`)

  // In-memory stores shared between the OAuth provider and the POST /authorize handler.
  const clients = new Map<string, OAuthClientInformationFull>()
  // code -> { token (DB bearer token), codeChallenge (for PKCE) }
  const authCodes = new Map<string, { token: string; codeChallenge: string }>()

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

  const oauthProvider: OAuthServerProvider = {
    clientsStore,

    // Render the interactive login form. The form POSTs to /authorize, which is
    // registered before mcpAuthRouter so it intercepts form submissions first.
    async authorize(_client, params, res) {
      const r = res as express.Response
      r.send(renderLoginForm({
        redirect_uri: params.redirectUri,
        state: params.state,
        code_challenge: params.codeChallenge,
        code_challenge_method: (params as Record<string, unknown>).codeChallengeMethod as string | undefined,
      }))
    },

    // Return the PKCE challenge stored at authorize time (don't delete — exchange needs the token).
    async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
      const entry = authCodes.get(authorizationCode)
      if (!entry) throw new Error('Unknown authorization code')
      return entry.codeChallenge
    },

    // Return the DB token issued at authorize time, then clean up the code.
    async exchangeAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
      const entry = authCodes.get(authorizationCode)
      if (!entry) throw new Error('Unknown authorization code')
      authCodes.delete(authorizationCode)
      return { access_token: entry.token, token_type: 'Bearer', expires_in: 365 * 24 * 3600 }
    },

    async exchangeRefreshToken(): Promise<OAuthTokens> {
      throw new Error('Refresh tokens are not supported')
    },

    // Accept any token — real DB validation happens in the /mcp handler.
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      return {
        token,
        clientId: 'unknown',
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      }
    },
  }

  const app = express()

  // POST /authorize — form submission handler.
  // Must be registered BEFORE mcpAuthRouter so it intercepts form POSTs
  // before the router's own /authorize handler can reject them.
  // urlencoded is scoped here so it doesn't consume the POST /token body.
  app.post('/authorize', express.urlencoded({ extended: false }), async (req, res) => {
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
      const org = await getOrgBySlug(db, orgSlug)
      if (!org) {
        res.send(renderLoginForm({ redirect_uri, state, code_challenge, code_challenge_method, error: `Org not found: ${orgSlug}` }))
        return
      }

      // Upsert developer and reuse an existing valid token if one exists.
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
        token = await issueToken(db, orgSlug, email)
      }

      const code = randomUUID()
      authCodes.set(code, { token, codeChallenge: code_challenge ?? '' })

      const redirectUrl = new URL(redirect_uri)
      redirectUrl.searchParams.set('code', code)
      if (state) redirectUrl.searchParams.set('state', state)

      res.redirect(redirectUrl.toString())
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Authentication failed'
      res.send(renderLoginForm({ redirect_uri, state, code_challenge, code_challenge_method, error: message }))
    }
  })

  // Mount the SDK OAuth router — handles /.well-known/*, /register, GET /authorize, /token.
  app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl }))

  // Bearer auth middleware — returns 401 + WWW-Authenticate on unauthenticated requests,
  // triggering the MCP client's automatic OAuth flow.
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    resourceMetadataUrl: `${issuerUrl.href}.well-known/oauth-protected-resource`,
  })

  // POST /auth/register — convenience endpoint to issue a token directly (bypassing OAuth flow).
  // Body: { orgSlug: string, email: string, name?: string }
  app.post('/auth/register', express.json(), async (req, res) => {
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
      const token = await issueToken(db, orgSlug, email, name ?? undefined)
      const orgCtx = await verifyToken(db, token)
      res.json({ token, developerId: orgCtx?.developerId })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(400).json({ error: message })
    }
  })

  // Active transports per MCP session.
  const transports = new Map<string, StreamableHTTPServerTransport>()

  app.all('/mcp', bearerAuth, async (req, res) => {
    // bearerAuth has already validated the token. Re-query for orgId + developerId.
    const authInfo = (req as unknown as { auth: AuthInfo }).auth
    const orgCtx = await verifyToken(db, authInfo.token)
    if (!orgCtx) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined

    let transport: StreamableHTTPServerTransport

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!
    } else if (req.method === 'POST' && !sessionId) {
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
    } else {
      res.status(400).json({ error: 'Bad request: missing or invalid session' })
      return
    }

    await transport.handleRequest(req, res)

    if (transport.sessionId && !transports.has(transport.sessionId)) {
      transports.set(transport.sessionId, transport)
    }
  })

  const server = createServer(app)

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve)
  })

  const addr = server.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : port

  return { server, port: actualPort }
}
