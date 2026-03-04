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
