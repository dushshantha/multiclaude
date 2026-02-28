# Agent Observability Platform — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a cloud SaaS platform that collects Claude Code session data via MCP and shows engineering leaders cost-per-PR, cost-per-ticket, and waste signals.

**Architecture:** A multi-tenant MCP collection server receives session events from Claude Code instances. A background attribution service connects to GitHub and Jira MCP servers to link sessions to outcomes. A Next.js dashboard surfaces ROI and waste metrics per org/team/developer.

**Tech Stack:** TypeScript (ESM), Express (collection server), Fastify (analytics API), PostgreSQL + Drizzle ORM, Vitest, Next.js + Tremor (dashboard), Clerk (auth), @modelcontextprotocol/sdk.

> **Note:** This is a new repository, separate from MultiClaude. Start by creating a new project directory.

---

## Phase 1: Data Pipe

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`

**Step 1: Create project directory and initialise**

```bash
mkdir agent-observability && cd agent-observability
npm init -y
```

**Step 2: Install dependencies**

```bash
npm install express @modelcontextprotocol/sdk drizzle-orm pg dotenv zod
npm install -D typescript tsx vitest @types/express @types/pg drizzle-kit
```

**Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

**Step 4: Write `package.json` scripts section**

```json
{
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:push": "drizzle-kit push"
  }
}
```

**Step 5: Write `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { globals: true, environment: 'node' }
})
```

**Step 6: Write `src/index.ts` (placeholder)**

```typescript
console.log('Agent Observability Platform')
```

**Step 7: Run tests to confirm zero-failure baseline**

```bash
npm test
```
Expected: `No test files found` (passWithNoTests)

**Step 8: Commit**

```bash
git init && git add . && git commit -m "chore: project scaffold"
```

---

### Task 2: Database Schema

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/index.ts`
- Create: `src/db/migrate.ts`
- Create: `tests/db/schema.test.ts`

**Step 1: Write failing test**

```typescript
// tests/db/schema.test.ts
import { describe, it, expect } from 'vitest'
import { orgs, developers, sessions } from '../../src/db/schema.js'

describe('schema', () => {
  it('exports orgs table', () => expect(orgs).toBeDefined())
  it('exports developers table', () => expect(developers).toBeDefined())
  it('exports sessions table', () => expect(sessions).toBeDefined())
})
```

**Step 2: Run to confirm failure**

```bash
npm test
```
Expected: FAIL — `Cannot find module '../../src/db/schema.js'`

**Step 3: Write `src/db/schema.ts`**

```typescript
import { pgTable, text, uuid, timestamp, numeric, integer, boolean } from 'drizzle-orm/pg-core'

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const developers = pgTable('developers', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => orgs.id),
  email: text('email').notNull(),
  name: text('name'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => orgs.id),
  developerId: uuid('developer_id').references(() => developers.id),
  agentType: text('agent_type').notNull().default('claude-code'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  endedAt: timestamp('ended_at'),
  durationSecs: integer('duration_secs'),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
  gitBranch: text('git_branch'),
  gitRepo: text('git_repo'),
  workingDir: text('working_dir'),
  taskDescription: text('task_description'),
})

export const outcomes = pgTable('outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id),
  orgId: uuid('org_id').notNull().references(() => orgs.id),
  type: text('type').notNull(), // 'pr' | 'ticket' | 'commit' | 'none'
  prUrl: text('pr_url'),
  linesAdded: integer('lines_added'),
  linesRemoved: integer('lines_removed'),
  reviewCycles: integer('review_cycles'),
  ticketId: text('ticket_id'),
  storyPoints: integer('story_points'),
  cycleTimeHours: numeric('cycle_time_hours', { precision: 8, scale: 2 }),
  linkedAt: timestamp('linked_at').defaultNow().notNull(),
})

export const wasteSessions = pgTable('waste_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id),
  orgId: uuid('org_id').notNull().references(() => orgs.id),
  reason: text('reason').notNull(),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull(),
  flaggedAt: timestamp('flagged_at').defaultNow().notNull(),
})
```

**Step 4: Write `src/db/index.ts`**

```typescript
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString })
  return drizzle(pool, { schema })
}

export type Db = ReturnType<typeof createDb>
```

**Step 5: Run tests**

```bash
npm test
```
Expected: PASS — 3 tests

**Step 6: Commit**

```bash
git add src/db/ tests/db/ && git commit -m "feat: database schema"
```

---

### Task 3: Org Management

**Files:**
- Create: `src/orgs/index.ts`
- Create: `tests/orgs/index.test.ts`

**Step 1: Write failing test**

```typescript
// tests/orgs/index.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createOrg, getOrgBySlug } from '../../src/orgs/index.js'

const mockDb = {
  insert: () => ({ values: () => ({ returning: async () => [{ id: 'org-1', slug: 'acme', name: 'Acme Corp', createdAt: new Date() }] }) }),
  query: { orgs: { findFirst: async () => ({ id: 'org-1', slug: 'acme', name: 'Acme Corp', createdAt: new Date() }) } }
} as any

describe('orgs', () => {
  it('creates an org and returns it', async () => {
    const org = await createOrg(mockDb, { name: 'Acme Corp', slug: 'acme' })
    expect(org.slug).toBe('acme')
    expect(org.name).toBe('Acme Corp')
  })

  it('gets an org by slug', async () => {
    const org = await getOrgBySlug(mockDb, 'acme')
    expect(org?.slug).toBe('acme')
  })

  it('returns null for unknown slug', async () => {
    const db = { query: { orgs: { findFirst: async () => undefined } } } as any
    const org = await getOrgBySlug(db, 'unknown')
    expect(org).toBeNull()
  })
})
```

**Step 2: Run to confirm failure**

```bash
npm test
```
Expected: FAIL — `Cannot find module '../../src/orgs/index.js'`

**Step 3: Write `src/orgs/index.ts`**

```typescript
import type { Db } from '../db/index.js'
import { orgs } from '../db/schema.js'
import { eq } from 'drizzle-orm'

export async function createOrg(db: Db, input: { name: string; slug: string }) {
  const [org] = await db.insert(orgs).values(input).returning()
  return org
}

export async function getOrgBySlug(db: Db, slug: string) {
  const org = await db.query.orgs.findFirst({ where: eq(orgs.slug, slug) })
  return org ?? null
}
```

**Step 4: Run tests**

```bash
npm test
```
Expected: PASS — 3 tests

**Step 5: Commit**

```bash
git add src/orgs/ tests/orgs/ && git commit -m "feat: org management"
```

---

### Task 4: Session Storage

**Files:**
- Create: `src/sessions/index.ts`
- Create: `tests/sessions/index.test.ts`

**Step 1: Write failing test**

```typescript
// tests/sessions/index.test.ts
import { describe, it, expect } from 'vitest'
import { createSession, updateSession, getSession, listSessions } from '../../src/sessions/index.js'

const SESSION = { id: 's-1', orgId: 'org-1', agentType: 'claude-code', startedAt: new Date(), tokensIn: 100, tokensOut: 200, costUsd: '0.001234', gitBranch: 'feat/PROJ-1', gitRepo: 'acme/app', workingDir: '/home/dev/app', taskDescription: 'Add login page', developerId: null, endedAt: null, durationSecs: null }

const mockDb = {
  insert: () => ({ values: () => ({ returning: async () => [SESSION] }) }),
  update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ ...SESSION, endedAt: new Date(), durationSecs: 120 }] }) }) }),
  query: {
    sessions: {
      findFirst: async () => SESSION,
      findMany: async () => [SESSION],
    }
  }
} as any

describe('sessions', () => {
  it('creates a session', async () => {
    const s = await createSession(mockDb, { orgId: 'org-1', gitBranch: 'feat/PROJ-1', taskDescription: 'Add login page' })
    expect(s.orgId).toBe('org-1')
    expect(s.agentType).toBe('claude-code')
  })

  it('updates a session with cost', async () => {
    const s = await updateSession(mockDb, 's-1', { tokensIn: 100, tokensOut: 200, costUsd: '0.001234', endedAt: new Date(), durationSecs: 120 })
    expect(s.durationSecs).toBe(120)
  })

  it('gets session by id', async () => {
    const s = await getSession(mockDb, 's-1')
    expect(s?.id).toBe('s-1')
  })

  it('lists sessions for org', async () => {
    const list = await listSessions(mockDb, 'org-1')
    expect(list).toHaveLength(1)
  })
})
```

**Step 2: Run to confirm failure**

```bash
npm test
```
Expected: FAIL

**Step 3: Write `src/sessions/index.ts`**

```typescript
import type { Db } from '../db/index.js'
import { sessions } from '../db/schema.js'
import { eq } from 'drizzle-orm'

export async function createSession(db: Db, input: {
  orgId: string
  developerId?: string
  gitBranch?: string
  gitRepo?: string
  workingDir?: string
  taskDescription?: string
}) {
  const [session] = await db.insert(sessions).values({
    orgId: input.orgId,
    developerId: input.developerId,
    gitBranch: input.gitBranch,
    gitRepo: input.gitRepo,
    workingDir: input.workingDir,
    taskDescription: input.taskDescription,
    agentType: 'claude-code',
  }).returning()
  return session
}

export async function updateSession(db: Db, sessionId: string, updates: {
  tokensIn?: number
  tokensOut?: number
  costUsd?: string
  endedAt?: Date
  durationSecs?: number
}) {
  const [session] = await db.update(sessions)
    .set(updates)
    .where(eq(sessions.id, sessionId))
    .returning()
  return session
}

export async function getSession(db: Db, sessionId: string) {
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) })
  return session ?? null
}

export async function listSessions(db: Db, orgId: string) {
  return db.query.sessions.findMany({ where: eq(sessions.orgId, orgId) })
}
```

**Step 4: Run tests**

```bash
npm test
```
Expected: PASS — 4 tests

**Step 5: Commit**

```bash
git add src/sessions/ tests/sessions/ && git commit -m "feat: session storage"
```

---

### Task 5: MCP Collection Server

**Files:**
- Create: `src/collection/server.ts`
- Create: `tests/collection/server.test.ts`

**Step 1: Write failing test**

```typescript
// tests/collection/server.test.ts
import { describe, it, expect } from 'vitest'
import { createCollectionServer } from '../../src/collection/server.js'

describe('collection server', () => {
  it('starts and returns port', async () => {
    const { port, httpServer } = await createCollectionServer({
      port: 0,
      getDb: () => ({ insert: () => ({ values: () => ({ returning: async () => [{ id: 's-1' }] }) }) }) as any
    })
    expect(port).toBeGreaterThan(0)
    await new Promise<void>(r => httpServer.close(() => r()))
  })
})
```

**Step 2: Run to confirm failure**

```bash
npm test
```
Expected: FAIL

**Step 3: Write `src/collection/server.ts`**

```typescript
import express from 'express'
import { createServer } from 'http'
import { randomUUID } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { z } from 'zod'
import type { Db } from '../db/index.js'
import { createSession, updateSession } from '../sessions/index.js'
import { getOrgBySlug } from '../orgs/index.js'
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'

function createLocalhostOAuthProvider(): OAuthServerProvider {
  const clients = new Map<string, OAuthClientInformationFull>()
  const codes = new Map<string, string>()
  const clientsStore: OAuthRegisteredClientsStore = {
    getClient: (id) => clients.get(id),
    registerClient(client) {
      const full = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) }
      clients.set(full.client_id, full)
      return full
    },
  }
  return {
    clientsStore,
    async authorize(client, params, res) {
      const code = randomUUID()
      codes.set(code, params.codeChallenge)
      const url = new URL(params.redirectUri)
      url.searchParams.set('code', code)
      if (params.state) url.searchParams.set('state', params.state)
      res.redirect(302, url.href)
    },
    async challengeForAuthorizationCode(_client, code) {
      const challenge = codes.get(code)
      if (!challenge) throw new Error('Unknown code')
      codes.delete(code)
      return challenge
    },
    async exchangeAuthorizationCode(): Promise<OAuthTokens> {
      return { access_token: randomUUID(), token_type: 'Bearer', expires_in: 365 * 24 * 3600 }
    },
    async exchangeRefreshToken(): Promise<OAuthTokens> {
      return { access_token: randomUUID(), token_type: 'Bearer', expires_in: 365 * 24 * 3600 }
    },
    async verifyAccessToken(token): Promise<AuthInfo> {
      return { token, clientId: 'developer', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600 }
    },
  }
}

function createOrgMcp(db: Db, orgId: string): McpServer {
  const server = new McpServer({ name: 'agentlens-collector', version: '1.0.0' })
  const activeSessions = new Map<string, string>() // connectionKey -> sessionId

  server.tool('report_session_start', 'Report start of a Claude Code session', {
    task_description: z.string().optional(),
    git_branch: z.string().optional(),
    git_repo: z.string().optional(),
    working_dir: z.string().optional(),
    developer_email: z.string().optional(),
  }, async (input) => {
    const session = await createSession(db, {
      orgId,
      gitBranch: input.git_branch,
      gitRepo: input.git_repo,
      workingDir: input.working_dir,
      taskDescription: input.task_description,
    })
    return { content: [{ type: 'text' as const, text: JSON.stringify({ session_id: session.id }) }] }
  })

  server.tool('report_cost', 'Report token usage and cost for a session', {
    session_id: z.string(),
    tokens_in: z.number(),
    tokens_out: z.number(),
    cost_usd: z.number(),
  }, async (input) => {
    await updateSession(db, input.session_id, {
      tokensIn: input.tokens_in,
      tokensOut: input.tokens_out,
      costUsd: input.cost_usd.toFixed(6),
    })
    return { content: [{ type: 'text' as const, text: 'Cost recorded' }] }
  })

  server.tool('report_task_complete', 'Report session completion', {
    session_id: z.string(),
    summary: z.string().optional(),
    pr_url: z.string().optional(),
  }, async (input) => {
    await updateSession(db, input.session_id, {
      endedAt: new Date(),
    })
    return { content: [{ type: 'text' as const, text: 'Session complete' }] }
  })

  return server
}

export async function createCollectionServer(opts: {
  port: number
  getDb: (orgSlug: string) => Db
}) {
  const app = express()
  app.use(express.json())

  const oauthProvider = createLocalhostOAuthProvider()

  // Each org slug gets its own MCP endpoint: /collect/:orgSlug
  // OAuth is mounted at root
  app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl: new URL('http://localhost') }))
  const bearerAuth = requireBearerAuth({ verifier: oauthProvider })

  const sessions = new Map<string, StreamableHTTPServerTransport>()

  app.all('/collect/:orgSlug', bearerAuth, async (req, res) => {
    const { orgSlug } = req.params
    const db = opts.getDb(orgSlug)
    const org = await getOrgBySlug(db, orgSlug)
    if (!org) { res.status(404).json({ error: 'Unknown org' }); return }

    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (sessionId) {
      const transport = sessions.get(`${orgSlug}:${sessionId}`)
      if (!transport) { res.status(404).json({ error: 'Session not found' }); return }
      await transport.handleRequest(req, res, req.body)
      return
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
    const mcp = createOrgMcp(db, org.id)
    await mcp.connect(transport)
    transport.onclose = () => { if (transport.sessionId) sessions.delete(`${orgSlug}:${transport.sessionId}`) }
    await transport.handleRequest(req, res, req.body)
    if (transport.sessionId) sessions.set(`${orgSlug}:${transport.sessionId}`, transport)
  })

  const httpServer = createServer(app)
  const port = await new Promise<number>(resolve =>
    httpServer.listen(opts.port, () => resolve((httpServer.address() as any).port))
  )

  return { port, httpServer }
}
```

**Step 4: Run tests**

```bash
npm test
```
Expected: PASS — all tests

**Step 5: Commit**

```bash
git add src/collection/ tests/collection/ && git commit -m "feat: MCP collection server"
```

---

## Phase 2: Attribution

### Task 6: GitHub MCP Client

**Files:**
- Create: `src/attribution/github.ts`
- Create: `tests/attribution/github.test.ts`

**Step 1: Write failing test**

```typescript
// tests/attribution/github.test.ts
import { describe, it, expect } from 'vitest'
import { findPrForBranch } from '../../src/attribution/github.js'

describe('github attribution', () => {
  it('finds a PR for a given branch', async () => {
    const mockClient = {
      callTool: async (name: string, args: any) => ({
        content: [{ type: 'text', text: JSON.stringify([{ number: 42, html_url: 'https://github.com/acme/app/pull/42', additions: 120, deletions: 30, merged_at: '2026-02-27T10:00:00Z' }]) }]
      })
    } as any

    const pr = await findPrForBranch(mockClient, { owner: 'acme', repo: 'app', branch: 'feat/PROJ-1' })
    expect(pr?.number).toBe(42)
    expect(pr?.url).toBe('https://github.com/acme/app/pull/42')
    expect(pr?.linesAdded).toBe(120)
  })

  it('returns null if no PR found', async () => {
    const mockClient = {
      callTool: async () => ({ content: [{ type: 'text', text: '[]' }] })
    } as any

    const pr = await findPrForBranch(mockClient, { owner: 'acme', repo: 'app', branch: 'feat/unknown' })
    expect(pr).toBeNull()
  })
})
```

**Step 2: Run to confirm failure**

```bash
npm test
```
Expected: FAIL

**Step 3: Write `src/attribution/github.ts`**

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

export interface PrSummary {
  number: number
  url: string
  linesAdded: number
  linesRemoved: number
  mergedAt: string | null
}

export async function findPrForBranch(
  client: Client,
  opts: { owner: string; repo: string; branch: string }
): Promise<PrSummary | null> {
  const result = await client.callTool({
    name: 'list_pull_requests',
    arguments: { owner: opts.owner, repo: opts.repo, head: opts.branch, state: 'all' }
  })

  const text = (result.content as any[])[0]?.text ?? '[]'
  const prs: any[] = JSON.parse(text)
  if (!prs.length) return null

  const pr = prs[0]
  return {
    number: pr.number,
    url: pr.html_url,
    linesAdded: pr.additions ?? 0,
    linesRemoved: pr.deletions ?? 0,
    mergedAt: pr.merged_at ?? null,
  }
}
```

**Step 4: Run tests**

```bash
npm test
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/attribution/github.ts tests/attribution/github.test.ts && git commit -m "feat: GitHub MCP attribution client"
```

---

### Task 7: Jira MCP Client

**Files:**
- Create: `src/attribution/jira.ts`
- Create: `tests/attribution/jira.test.ts`

**Step 1: Write failing test**

```typescript
// tests/attribution/jira.test.ts
import { describe, it, expect } from 'vitest'
import { findTicketForBranch } from '../../src/attribution/jira.js'

describe('jira attribution', () => {
  it('extracts ticket ID from branch name', async () => {
    const mockClient = {
      callTool: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ key: 'PROJ-1', fields: { story_points: 5, status: { name: 'Done' } } }) }]
      })
    } as any

    const ticket = await findTicketForBranch(mockClient, 'feat/PROJ-1')
    expect(ticket?.id).toBe('PROJ-1')
    expect(ticket?.storyPoints).toBe(5)
  })

  it('returns null if branch has no ticket ID', async () => {
    const ticket = await findTicketForBranch({} as any, 'fix/typo-in-readme')
    expect(ticket).toBeNull()
  })
})
```

**Step 2: Run to confirm failure**

```bash
npm test
```
Expected: FAIL

**Step 3: Write `src/attribution/jira.ts`**

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

export interface TicketSummary {
  id: string
  storyPoints: number | null
  status: string
}

// Extract Jira-style ticket ID from branch name (e.g. feat/PROJ-123 → PROJ-123)
function extractTicketId(branch: string): string | null {
  const match = branch.match(/([A-Z]+-\d+)/i)
  return match ? match[1].toUpperCase() : null
}

export async function findTicketForBranch(
  client: Client,
  branch: string
): Promise<TicketSummary | null> {
  const ticketId = extractTicketId(branch)
  if (!ticketId) return null

  try {
    const result = await client.callTool({ name: 'get_issue', arguments: { issue_key: ticketId } })
    const text = (result.content as any[])[0]?.text
    if (!text) return null

    const issue = JSON.parse(text)
    return {
      id: issue.key,
      storyPoints: issue.fields?.story_points ?? null,
      status: issue.fields?.status?.name ?? 'unknown',
    }
  } catch {
    return null
  }
}
```

**Step 4: Run tests**

```bash
npm test
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/attribution/jira.ts tests/attribution/jira.test.ts && git commit -m "feat: Jira MCP attribution client"
```

---

### Task 8: Attribution Engine

**Files:**
- Create: `src/attribution/engine.ts`
- Create: `tests/attribution/engine.test.ts`

**Step 1: Write failing test**

```typescript
// tests/attribution/engine.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runAttributionPass } from '../../src/attribution/engine.js'

describe('attribution engine', () => {
  it('links session to PR and ticket', async () => {
    const mockDb = {
      query: {
        sessions: { findMany: async () => [{ id: 's-1', orgId: 'org-1', gitBranch: 'feat/PROJ-1', gitRepo: 'acme/app', costUsd: '0.84' }] },
        outcomes: { findFirst: async () => null }
      },
      insert: () => ({ values: () => ({ returning: async () => [{ id: 'o-1' }] }) })
    } as any

    const findPr = vi.fn().mockResolvedValue({ number: 42, url: 'https://github.com/acme/app/pull/42', linesAdded: 120, linesRemoved: 30, mergedAt: '2026-02-27' })
    const findTicket = vi.fn().mockResolvedValue({ id: 'PROJ-1', storyPoints: 5, status: 'Done' })

    const linked = await runAttributionPass(mockDb, { findPr, findTicket })
    expect(linked).toBe(1)
    expect(findPr).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feat/PROJ-1' }))
    expect(findTicket).toHaveBeenCalledWith('feat/PROJ-1')
  })

  it('skips sessions already attributed', async () => {
    const mockDb = {
      query: {
        sessions: { findMany: async () => [{ id: 's-1', orgId: 'org-1', gitBranch: 'feat/PROJ-1', gitRepo: 'acme/app' }] },
        outcomes: { findFirst: async () => ({ id: 'o-existing' }) }
      }
    } as any

    const linked = await runAttributionPass(mockDb, { findPr: vi.fn(), findTicket: vi.fn() })
    expect(linked).toBe(0)
  })
})
```

**Step 2: Run to confirm failure**

```bash
npm test
```
Expected: FAIL

**Step 3: Write `src/attribution/engine.ts`**

```typescript
import type { Db } from '../db/index.js'
import { outcomes, sessions } from '../db/schema.js'
import { isNull, eq } from 'drizzle-orm'

interface PrResult { number: number; url: string; linesAdded: number; linesRemoved: number; mergedAt: string | null }
interface TicketResult { id: string; storyPoints: number | null; status: string }

interface AttributionDeps {
  findPr: (opts: { owner: string; repo: string; branch: string }) => Promise<PrResult | null>
  findTicket: (branch: string) => Promise<TicketResult | null>
}

export async function runAttributionPass(db: Db, deps: AttributionDeps): Promise<number> {
  // Find sessions with no outcome yet
  const unattributed = await db.query.sessions.findMany({
    where: isNull(sessions.endedAt),
  })

  let linked = 0

  for (const session of unattributed) {
    if (!session.gitBranch || !session.gitRepo) continue

    // Check if already attributed
    const existing = await db.query.outcomes.findFirst({
      where: eq(outcomes.sessionId, session.id)
    })
    if (existing) continue

    // Parse repo into owner/repo
    const parts = session.gitRepo.split('/')
    if (parts.length < 2) continue
    const [owner, repo] = parts

    const pr = await deps.findPr({ owner, repo, branch: session.gitBranch })
    if (!pr) continue

    const ticket = await deps.findTicket(session.gitBranch)

    await db.insert(outcomes).values({
      sessionId: session.id,
      orgId: session.orgId,
      type: 'pr',
      prUrl: pr.url,
      linesAdded: pr.linesAdded,
      linesRemoved: pr.linesRemoved,
      ticketId: ticket?.id,
      storyPoints: ticket?.storyPoints,
    })

    linked++
  }

  return linked
}
```

**Step 4: Run tests**

```bash
npm test
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/attribution/ tests/attribution/ && git commit -m "feat: attribution engine"
```

---

### Task 9: Waste Detection

**Files:**
- Create: `src/waste/index.ts`
- Create: `tests/waste/index.test.ts`

**Step 1: Write failing test**

```typescript
// tests/waste/index.test.ts
import { describe, it, expect } from 'vitest'
import { detectWaste } from '../../src/waste/index.js'

const TWO_DAYS_AGO = new Date(Date.now() - 49 * 60 * 60 * 1000)

describe('waste detection', () => {
  it('flags sessions older than 48h with no outcome', async () => {
    const mockDb = {
      query: {
        sessions: { findMany: async () => [
          { id: 's-1', orgId: 'org-1', startedAt: TWO_DAYS_AGO, costUsd: '1.50' },
        ]},
        outcomes: { findFirst: async () => null },
        wasteSessions: { findFirst: async () => null }
      },
      insert: () => ({ values: () => ({ returning: async () => [{ id: 'w-1' }] }) })
    } as any

    const flagged = await detectWaste(mockDb)
    expect(flagged).toBe(1)
  })

  it('skips sessions younger than 48h', async () => {
    const mockDb = {
      query: {
        sessions: { findMany: async () => [
          { id: 's-2', orgId: 'org-1', startedAt: new Date(), costUsd: '0.50' },
        ]},
        outcomes: { findFirst: async () => null },
        wasteSessions: { findFirst: async () => null }
      },
    } as any

    const flagged = await detectWaste(mockDb)
    expect(flagged).toBe(0)
  })

  it('skips sessions already flagged', async () => {
    const mockDb = {
      query: {
        sessions: { findMany: async () => [
          { id: 's-3', orgId: 'org-1', startedAt: TWO_DAYS_AGO, costUsd: '2.00' },
        ]},
        outcomes: { findFirst: async () => null },
        wasteSessions: { findFirst: async () => ({ id: 'w-existing' }) }
      }
    } as any

    const flagged = await detectWaste(mockDb)
    expect(flagged).toBe(0)
  })
})
```

**Step 2: Run to confirm failure**

```bash
npm test
```
Expected: FAIL

**Step 3: Write `src/waste/index.ts`**

```typescript
import type { Db } from '../db/index.js'
import { wasteSessions, sessions, outcomes } from '../db/schema.js'
import { eq } from 'drizzle-orm'

const WASTE_THRESHOLD_MS = 48 * 60 * 60 * 1000

export async function detectWaste(db: Db): Promise<number> {
  const allSessions = await db.query.sessions.findMany()
  let flagged = 0

  for (const session of allSessions) {
    const ageMs = Date.now() - session.startedAt.getTime()
    if (ageMs < WASTE_THRESHOLD_MS) continue

    const outcome = await db.query.outcomes.findFirst({ where: eq(outcomes.sessionId, session.id) })
    if (outcome) continue

    const alreadyFlagged = await db.query.wasteSessions.findFirst({ where: eq(wasteSessions.sessionId, session.id) })
    if (alreadyFlagged) continue

    await db.insert(wasteSessions).values({
      sessionId: session.id,
      orgId: session.orgId,
      reason: 'no_outcome_48h',
      costUsd: session.costUsd,
    })

    flagged++
  }

  return flagged
}
```

**Step 4: Run tests**

```bash
npm test
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/waste/ tests/waste/ && git commit -m "feat: waste detection"
```

---

### Task 10: Analytics Aggregations

**Files:**
- Create: `src/analytics/index.ts`
- Create: `tests/analytics/index.test.ts`

**Step 1: Write failing test**

```typescript
// tests/analytics/index.test.ts
import { describe, it, expect } from 'vitest'
import { getOrgMetrics } from '../../src/analytics/index.js'

describe('analytics', () => {
  it('calculates cost_per_pr', async () => {
    const mockDb = {
      execute: async (query: any) => ({
        rows: [{ total_cost: '10.00', pr_count: '4', ticket_count: '3', waste_cost: '2.00', active_devs: '5' }]
      })
    } as any

    const metrics = await getOrgMetrics(mockDb, 'org-1')
    expect(metrics.costPerPr).toBe(2.50)
    expect(metrics.costPerTicket).toBeCloseTo(3.33, 1)
    expect(metrics.wasteUsd).toBe(2.00)
    expect(metrics.activeDevelopers).toBe(5)
  })
})
```

**Step 2: Run to confirm failure**

```bash
npm test
```
Expected: FAIL

**Step 3: Write `src/analytics/index.ts`**

```typescript
import type { Db } from '../db/index.js'
import { sql } from 'drizzle-orm'

export interface OrgMetrics {
  totalCostUsd: number
  costPerPr: number
  costPerTicket: number
  wasteUsd: number
  activeDevelopers: number
}

export async function getOrgMetrics(db: Db, orgId: string): Promise<OrgMetrics> {
  const result = await (db as any).execute(sql`
    SELECT
      COALESCE(SUM(s.cost_usd::numeric), 0) as total_cost,
      COUNT(DISTINCT o.id) FILTER (WHERE o.type = 'pr') as pr_count,
      COUNT(DISTINCT o.id) FILTER (WHERE o.ticket_id IS NOT NULL) as ticket_count,
      COALESCE(SUM(w.cost_usd::numeric), 0) as waste_cost,
      COUNT(DISTINCT s.developer_id) as active_devs
    FROM sessions s
    LEFT JOIN outcomes o ON o.session_id = s.id
    LEFT JOIN waste_sessions w ON w.session_id = s.id
    WHERE s.org_id = ${orgId}
      AND s.started_at > NOW() - INTERVAL '30 days'
  `)

  const row = result.rows[0]
  const totalCost = parseFloat(row.total_cost)
  const prCount = parseInt(row.pr_count) || 0
  const ticketCount = parseInt(row.ticket_count) || 0

  return {
    totalCostUsd: totalCost,
    costPerPr: prCount > 0 ? totalCost / prCount : 0,
    costPerTicket: ticketCount > 0 ? totalCost / ticketCount : 0,
    wasteUsd: parseFloat(row.waste_cost),
    activeDevelopers: parseInt(row.active_devs) || 0,
  }
}
```

**Step 4: Run tests**

```bash
npm test
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/analytics/ tests/analytics/ && git commit -m "feat: analytics aggregations"
```

---

## Phase 3: Dashboard

### Task 11: Next.js + Clerk Setup

**Files:**
- Create: `dashboard/` (separate Next.js app inside the monorepo)

**Step 1: Scaffold Next.js app**

```bash
npx create-next-app@latest dashboard --typescript --tailwind --app --no-src-dir
cd dashboard
npm install @tremor/react @clerk/nextjs
```

**Step 2: Add Clerk to `dashboard/app/layout.tsx`**

```typescript
import { ClerkProvider } from '@clerk/nextjs'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  )
}
```

**Step 3: Add `.env.local`**

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_API_URL=http://localhost:4000
```

**Step 4: Verify dev server starts**

```bash
npm run dev
```
Expected: App running at `http://localhost:3000`

**Step 5: Commit**

```bash
cd .. && git add dashboard/ && git commit -m "feat: Next.js dashboard scaffold with Clerk auth"
```

---

### Task 12: Analytics API (Fastify)

**Files:**
- Create: `src/api/server.ts`
- Create: `tests/api/server.test.ts`

**Step 1: Install Fastify**

```bash
npm install fastify @fastify/cors
```

**Step 2: Write failing test**

```typescript
// tests/api/server.test.ts
import { describe, it, expect } from 'vitest'
import { buildApiServer } from '../../src/api/server.js'

describe('analytics API', () => {
  it('returns 200 on /health', async () => {
    const mockDb = {} as any
    const app = buildApiServer(mockDb)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
  })
})
```

**Step 3: Write `src/api/server.ts`**

```typescript
import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { Db } from '../db/index.js'
import { getOrgMetrics } from '../analytics/index.js'
import { listSessions } from '../sessions/index.js'

export function buildApiServer(db: Db) {
  const app = Fastify({ logger: false })
  app.register(cors, { origin: true })

  app.get('/health', async () => ({ ok: true }))

  app.get('/orgs/:orgId/metrics', async (req) => {
    const { orgId } = req.params as { orgId: string }
    return getOrgMetrics(db, orgId)
  })

  app.get('/orgs/:orgId/sessions', async (req) => {
    const { orgId } = req.params as { orgId: string }
    return listSessions(db, orgId)
  })

  return app
}
```

**Step 4: Run tests**

```bash
npm test
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/ tests/api/ && git commit -m "feat: Fastify analytics API"
```

---

### Task 13: Director Dashboard

**Files:**
- Create: `dashboard/app/dashboard/page.tsx`
- Create: `dashboard/components/RoiPanel.tsx`
- Create: `dashboard/components/WastePanel.tsx`

**Step 1: Write `dashboard/components/RoiPanel.tsx`**

```typescript
import { Card, Metric, Text, Flex, BadgeDelta } from '@tremor/react'

interface RoiPanelProps {
  costPerPr: number
  costPerTicket: number
  totalCost: number
  prevTotalCost: number
}

export function RoiPanel({ costPerPr, costPerTicket, totalCost, prevTotalCost }: RoiPanelProps) {
  const delta = prevTotalCost > 0 ? ((totalCost - prevTotalCost) / prevTotalCost) * 100 : 0

  return (
    <Card>
      <Text>ROI — last 30 days</Text>
      <Flex className="mt-4 gap-8">
        <div>
          <Text>Cost per PR</Text>
          <Metric>${costPerPr.toFixed(2)}</Metric>
        </div>
        <div>
          <Text>Cost per Ticket</Text>
          <Metric>${costPerTicket.toFixed(2)}</Metric>
        </div>
        <div>
          <Text>Total AI Spend</Text>
          <Flex alignItems="center" className="gap-2">
            <Metric>${totalCost.toFixed(0)}</Metric>
            <BadgeDelta deltaType={delta < 0 ? 'decrease' : 'increase'}>
              {Math.abs(delta).toFixed(0)}%
            </BadgeDelta>
          </Flex>
        </div>
      </Flex>
    </Card>
  )
}
```

**Step 2: Write `dashboard/components/WastePanel.tsx`**

```typescript
import { Card, Text, Metric, Table, TableHead, TableRow, TableHeaderCell, TableBody, TableCell } from '@tremor/react'

interface WasteEntry { developer: string; costUsd: number; sessionCount: number; reason: string }
interface WastePanelProps { totalWaste: number; entries: WasteEntry[] }

export function WastePanel({ totalWaste, entries }: WastePanelProps) {
  return (
    <Card className="border-amber-200">
      <Text>⚠ Waste detected</Text>
      <Metric className="text-amber-600">${totalWaste.toFixed(2)}</Metric>
      <Text className="mt-1 text-sm text-gray-500">sessions with no linked PR or ticket (last 30 days)</Text>
      <Table className="mt-4">
        <TableHead>
          <TableRow>
            <TableHeaderCell>Developer</TableHeaderCell>
            <TableHeaderCell>Cost</TableHeaderCell>
            <TableHeaderCell>Sessions</TableHeaderCell>
            <TableHeaderCell>Reason</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {entries.map(e => (
            <TableRow key={e.developer}>
              <TableCell>{e.developer}</TableCell>
              <TableCell>${e.costUsd.toFixed(2)}</TableCell>
              <TableCell>{e.sessionCount}</TableCell>
              <TableCell>{e.reason}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}
```

**Step 3: Write `dashboard/app/dashboard/page.tsx`**

```typescript
import { auth } from '@clerk/nextjs/server'
import { RoiPanel } from '../../components/RoiPanel'
import { WastePanel } from '../../components/WastePanel'

async function getMetrics(orgId: string) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/orgs/${orgId}/metrics`, { cache: 'no-store' })
  return res.json()
}

export default async function DashboardPage() {
  const { orgId } = auth()
  if (!orgId) return <div>Not authenticated</div>

  const metrics = await getMetrics(orgId)

  return (
    <main className="p-8 space-y-6">
      <h1 className="text-2xl font-bold">Agent Observability</h1>
      <RoiPanel
        costPerPr={metrics.costPerPr}
        costPerTicket={metrics.costPerTicket}
        totalCost={metrics.totalCostUsd}
        prevTotalCost={0}
      />
      <WastePanel totalWaste={metrics.wasteUsd} entries={[]} />
    </main>
  )
}
```

**Step 4: Verify dashboard renders**

```bash
cd dashboard && npm run dev
```
Expected: Dashboard visible at `http://localhost:3000/dashboard`

**Step 5: Commit**

```bash
cd .. && git add dashboard/ && git commit -m "feat: director dashboard (ROI + waste panels)"
```

---

### Task 14: Developer Personal View

**Files:**
- Create: `dashboard/app/me/page.tsx`
- Create: `dashboard/components/SessionTable.tsx`

**Step 1: Write `dashboard/components/SessionTable.tsx`**

```typescript
import { Table, TableHead, TableRow, TableHeaderCell, TableBody, TableCell, Badge } from '@tremor/react'

interface Session { id: string; gitBranch: string; costUsd: string; startedAt: string; outcome: string | null }
interface SessionTableProps { sessions: Session[] }

export function SessionTable({ sessions }: SessionTableProps) {
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeaderCell>Branch</TableHeaderCell>
          <TableHeaderCell>Cost</TableHeaderCell>
          <TableHeaderCell>Date</TableHeaderCell>
          <TableHeaderCell>Outcome</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {sessions.map(s => (
          <TableRow key={s.id}>
            <TableCell className="font-mono text-sm">{s.gitBranch ?? '—'}</TableCell>
            <TableCell>${parseFloat(s.costUsd).toFixed(2)}</TableCell>
            <TableCell>{new Date(s.startedAt).toLocaleDateString()}</TableCell>
            <TableCell>
              {s.outcome
                ? <Badge color="green">{s.outcome}</Badge>
                : <Badge color="amber">⚠ no outcome</Badge>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
```

**Step 2: Write `dashboard/app/me/page.tsx`**

```typescript
import { auth } from '@clerk/nextjs/server'
import { Card, Metric, Text, Flex } from '@tremor/react'
import { SessionTable } from '../../components/SessionTable'

async function getDeveloperSessions(orgId: string) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/orgs/${orgId}/sessions`, { cache: 'no-store' })
  return res.json()
}

export default async function MePage() {
  const { orgId } = auth()
  if (!orgId) return <div>Not authenticated</div>

  const sessions = await getDeveloperSessions(orgId)
  const totalCost = sessions.reduce((sum: number, s: any) => sum + parseFloat(s.costUsd ?? 0), 0)
  const prs = sessions.filter((s: any) => s.outcome === 'pr').length

  return (
    <main className="p-8 space-y-6">
      <h1 className="text-2xl font-bold">My AI Usage</h1>
      <Flex className="gap-6">
        <Card>
          <Text>Total spend (30d)</Text>
          <Metric>${totalCost.toFixed(2)}</Metric>
        </Card>
        <Card>
          <Text>PRs shipped</Text>
          <Metric>{prs}</Metric>
        </Card>
        <Card>
          <Text>Cost per PR</Text>
          <Metric>{prs > 0 ? `$${(totalCost / prs).toFixed(2)}` : '—'}</Metric>
        </Card>
      </Flex>
      <Card>
        <Text>Recent sessions</Text>
        <SessionTable sessions={sessions} />
      </Card>
    </main>
  )
}
```

**Step 3: Verify personal view renders**

```bash
cd dashboard && npm run dev
```
Expected: Personal view at `http://localhost:3000/me`

**Step 4: Run all backend tests**

```bash
cd .. && npm test
```
Expected: All tests PASS

**Step 5: Final commit**

```bash
git add dashboard/ && git commit -m "feat: developer personal dashboard"
```

---

## Done — Summary of What Was Built

| Phase | Tasks | Outcome |
|---|---|---|
| Data Pipe | 1–5 | Multi-tenant MCP server collecting Claude Code sessions |
| Attribution | 6–10 | GitHub + Jira MCP clients, waste detection, aggregations |
| Dashboard | 11–14 | Next.js director view + developer personal view with Clerk auth |

**To run locally:**
```bash
# Backend
npm start

# Dashboard
cd dashboard && npm run dev
```

**Connect Claude Code to your local instance:**
```json
{
  "mcpServers": {
    "agentlens": {
      "type": "http",
      "url": "http://localhost:3001/collect/your-org-slug"
    }
  }
}
```
