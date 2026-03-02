import { describe, it, expect, afterEach } from 'vitest'
import type { Server } from 'node:http'
import { createCollectionServer } from '../../src/collection/server.js'

const mockDb = {
  insert: () => ({ values: () => ({ returning: async () => [{ id: 'session-1', orgId: 'org-1', agentType: 'claude-code', startedAt: new Date(), tokensIn: 0, tokensOut: 0, costUsd: '0', gitBranch: null, gitRepo: null, workingDir: null, taskDescription: null, developerId: null, endedAt: null, durationSecs: null }] }) }),
  update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  select: () => ({ from: () => ({ where: async () => [] }) }),
  query: {
    sessions: { findFirst: async () => null, findMany: async () => [] },
    orgs: { findFirst: async () => null },
  }
} as any

describe('createCollectionServer', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(servers.map(s => new Promise<void>(resolve => s.close(() => resolve()))))
    servers.length = 0
  })

  it('starts and returns a port number', async () => {
    const { server, port } = await createCollectionServer(mockDb)
    servers.push(server)
    expect(typeof port).toBe('number')
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
  })

  it('listens on the returned port', async () => {
    const { server, port } = await createCollectionServer(mockDb)
    servers.push(server)
    const addr = server.address()
    expect(addr).not.toBeNull()
    if (addr && typeof addr === 'object') {
      expect(addr.port).toBe(port)
    }
  })
})
