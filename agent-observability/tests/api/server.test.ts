import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildApiServer } from '../../src/api/server.js'

// Mock the analytics and sessions modules
vi.mock('../../src/analytics/index.js', () => ({
  getOrgMetrics: vi.fn().mockResolvedValue({
    costPerPr: 12.5,
    costPerTicket: 8.0,
    waste: 3.2,
  }),
}))

vi.mock('../../src/sessions/index.js', () => ({
  listSessions: vi.fn().mockResolvedValue([
    { id: 'session-1', orgId: 'org-1', agentType: 'claude-code', costUsd: '5.00' },
  ]),
}))

const mockDb = {} as any

describe('Analytics API Server', () => {
  let app: Awaited<ReturnType<typeof buildApiServer>>

  beforeEach(async () => {
    app = await buildApiServer(mockDb)
  })

  describe('GET /health', () => {
    it('returns 200 with { ok: true }', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ ok: true })
    })
  })

  describe('GET /orgs/:orgId/metrics', () => {
    it('returns metrics for an org', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/orgs/org-1/metrics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body).toMatchObject({
        costPerPr: 12.5,
        costPerTicket: 8.0,
        waste: 3.2,
      })
    })
  })

  describe('GET /orgs/:orgId/sessions', () => {
    it('returns sessions list for an org', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/orgs/org-1/sessions',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(Array.isArray(body)).toBe(true)
      expect(body[0]).toMatchObject({ id: 'session-1', orgId: 'org-1' })
    })
  })
})
