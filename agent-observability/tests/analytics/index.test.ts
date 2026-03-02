import { describe, it, expect, vi } from 'vitest'
import { getOrgMetrics } from '../../src/analytics/index.js'
import type { Db } from '../../src/db/index.js'

describe('getOrgMetrics', () => {
  it('returns cost_per_pr, cost_per_ticket, and waste for an org', async () => {
    const mockDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ cost_per_pr: '5.250000', pr_count: '4' }] })
        .mockResolvedValueOnce({ rows: [{ cost_per_ticket: '12.500000', ticket_count: '2' }] })
        .mockResolvedValueOnce({ rows: [{ total_waste: '3.140000' }] }),
    } as unknown as Db

    const result = await getOrgMetrics(mockDb, 'org-123')

    expect(result.costPerPr).toBeCloseTo(5.25)
    expect(result.costPerTicket).toBeCloseTo(12.5)
    expect(result.waste).toBeCloseTo(3.14)
    expect(mockDb.execute).toHaveBeenCalledTimes(3)
  })

  it('returns zeros when no data exists', async () => {
    const mockDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ cost_per_pr: '0', pr_count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ cost_per_ticket: '0', ticket_count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ total_waste: '0' }] }),
    } as unknown as Db

    const result = await getOrgMetrics(mockDb, 'org-456')

    expect(result.costPerPr).toBe(0)
    expect(result.costPerTicket).toBe(0)
    expect(result.waste).toBe(0)
  })

  it('handles empty rows gracefully', async () => {
    const mockDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    } as unknown as Db

    const result = await getOrgMetrics(mockDb, 'org-789')

    expect(result.costPerPr).toBe(0)
    expect(result.costPerTicket).toBe(0)
    expect(result.waste).toBe(0)
  })
})
