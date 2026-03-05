import { describe, it, expect, afterEach } from 'vitest'
import type { Server } from 'node:http'
import { createCollectionServer, createLocalhostOAuthProvider } from '../../src/collection/server.js'
import { orgs as orgsTable } from '../../src/db/schema.js'

const mockOrg = { id: 'org-1', slug: 'acme', name: 'Acme', createdAt: new Date() }
const mockDeveloper = { id: 'dev-1', orgId: 'org-1', email: 'alice@example.com', name: 'Alice', createdAt: new Date() }
const mockSession = { id: 'session-1', orgId: 'org-1', agentType: 'claude-code', startedAt: new Date(), tokensIn: 0, tokensOut: 0, costUsd: '0', gitBranch: null, gitRepo: null, workingDir: null, taskDescription: null, developerId: null, endedAt: null, durationSecs: null }

function makeMockDb(orgFound = true, developerFound = false) {
  return {
    insert: () => ({
      values: () => ({
        returning: async () => [developerFound ? mockDeveloper : { ...mockDeveloper, id: 'dev-new' }],
      }),
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [mockSession] }) }) }),
    // Differentiate org vs developer queries by the table passed to .from()
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === orgsTable) return orgFound ? [mockOrg] : []
          // developer table query
          return developerFound ? [mockDeveloper] : []
        },
      }),
    }),
    query: {
      sessions: { findFirst: async () => null, findMany: async () => [] },
      orgs: { findFirst: async () => (orgFound ? mockOrg : null) },
    },
  } as any
}

describe('createCollectionServer', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(servers.map(s => new Promise<void>(resolve => s.close(() => resolve()))))
    servers.length = 0
  })

  it('starts and returns a port number', async () => {
    const { server, port } = await createCollectionServer(makeMockDb())
    servers.push(server)
    expect(typeof port).toBe('number')
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
  })

  it('listens on the returned port', async () => {
    const { server, port } = await createCollectionServer(makeMockDb())
    servers.push(server)
    const addr = server.address()
    expect(addr).not.toBeNull()
    if (addr && typeof addr === 'object') {
      expect(addr.port).toBe(port)
    }
  })

  describe('POST /auth/register', () => {
    it('returns 400 when orgSlug is missing', async () => {
      const { server, port } = await createCollectionServer(makeMockDb())
      servers.push(server)
      const res = await fetch(`http://127.0.0.1:${port}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/orgSlug/)
    })

    it('returns 400 when email is missing', async () => {
      const { server, port } = await createCollectionServer(makeMockDb())
      servers.push(server)
      const res = await fetch(`http://127.0.0.1:${port}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgSlug: 'acme' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/email/)
    })

    it('returns 400 when org is not found', async () => {
      const { server, port } = await createCollectionServer(makeMockDb(false))
      servers.push(server)
      const res = await fetch(`http://127.0.0.1:${port}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgSlug: 'no-such-org', email: 'alice@example.com' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/not found/i)
    })

    it('returns token and developerId on success', async () => {
      const { server, port } = await createCollectionServer(makeMockDb(true, false))
      servers.push(server)
      const res = await fetch(`http://127.0.0.1:${port}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgSlug: 'acme', email: 'alice@example.com', name: 'Alice' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { token: string; developerId: string }
      expect(typeof body.token).toBe('string')
      expect(body.token.length).toBeGreaterThan(0)
      expect(typeof body.developerId).toBe('string')
      expect(body.developerId.length).toBeGreaterThan(0)
    })
  })
})

describe('createLocalhostOAuthProvider', () => {
  it('issueToken without email stores no developerId', async () => {
    const db = makeMockDb(true)
    const provider = createLocalhostOAuthProvider(db)
    const token = await provider.issueToken('acme')
    const ctx = provider.verifyToken(token)
    expect(ctx).not.toBeNull()
    expect(ctx!.orgId).toBe('org-1')
    expect(ctx!.developerId).toBeUndefined()
  })

  it('issueToken with email stores developerId in token context', async () => {
    const db = makeMockDb(true, false)
    const provider = createLocalhostOAuthProvider(db)
    const token = await provider.issueToken('acme', 'alice@example.com', 'Alice')
    const ctx = provider.verifyToken(token)
    expect(ctx).not.toBeNull()
    expect(ctx!.orgId).toBe('org-1')
    expect(typeof ctx!.developerId).toBe('string')
    expect(ctx!.developerId!.length).toBeGreaterThan(0)
  })

  it('verifyToken returns null for unknown token', () => {
    const db = makeMockDb(true)
    const provider = createLocalhostOAuthProvider(db)
    expect(provider.verifyToken('not-a-real-token')).toBeNull()
  })

  it('revokeToken invalidates subsequent verifications', async () => {
    const db = makeMockDb(true)
    const provider = createLocalhostOAuthProvider(db)
    const token = await provider.issueToken('acme')
    provider.revokeToken(token)
    expect(provider.verifyToken(token)).toBeNull()
  })
})
