import { describe, it, expect, vi } from 'vitest'
import { createOrg, getOrgBySlug } from '../../src/orgs/index.js'
import type { Db } from '../../src/db/index.js'

const mockOrg = {
  id: '00000000-0000-0000-0000-000000000001',
  slug: 'acme',
  name: 'Acme Corp',
  createdAt: new Date('2026-01-01T00:00:00Z'),
}

function makeMockDb(overrides: Partial<Db> = {}): Db {
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([mockOrg]),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([mockOrg]),
      }),
    }),
    ...overrides,
  } as unknown as Db
}

describe('createOrg', () => {
  it('inserts a new org and returns it', async () => {
    const db = makeMockDb()
    const result = await createOrg(db, { slug: 'acme', name: 'Acme Corp' })
    expect(result).toEqual(mockOrg)
  })
})

describe('getOrgBySlug', () => {
  it('returns org when found', async () => {
    const db = makeMockDb()
    const result = await getOrgBySlug(db, 'acme')
    expect(result).toEqual(mockOrg)
  })

  it('returns null when org is not found', async () => {
    const db = makeMockDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as Partial<Db>)
    const result = await getOrgBySlug(db, 'nonexistent')
    expect(result).toBeNull()
  })
})
