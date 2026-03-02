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
