import { describe, it, expect, vi } from 'vitest'
import { runAttributionPass } from '../../src/attribution/engine.js'
import type { Db } from '../../src/db/index.js'

const mockSession = {
  id: '00000000-0000-0000-0000-000000000001',
  orgId: '00000000-0000-0000-0000-000000000002',
  gitBranch: 'feat/PROJ-123-add-feature',
  gitRepo: 'owner/repo',
}

function makeMockDb(unattributedSessions: unknown[] = []): Db {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(unattributedSessions),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue([]),
    }),
  } as unknown as Db
}

describe('runAttributionPass', () => {
  it('links session to PR when findPr returns a result', async () => {
    const db = makeMockDb([mockSession])
    const findPr = vi.fn().mockResolvedValue({
      number: 42,
      title: 'feat: add feature',
      url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
    })
    const findTicket = vi.fn().mockResolvedValue(null)

    const count = await runAttributionPass(db, { findPr, findTicket })

    expect(count).toBe(1)
    expect(findPr).toHaveBeenCalledWith('owner/repo', 'feat/PROJ-123-add-feature')
    expect(db.insert).toHaveBeenCalled()
  })

  it('links session to ticket when findTicket returns a result', async () => {
    const db = makeMockDb([mockSession])
    const findPr = vi.fn().mockResolvedValue(null)
    const findTicket = vi.fn().mockResolvedValue({
      id: 'PROJ-123',
      storyPoints: 5,
      status: 'Done',
    })

    const count = await runAttributionPass(db, { findPr, findTicket })

    expect(count).toBe(1)
    expect(findTicket).toHaveBeenCalledWith('feat/PROJ-123-add-feature')
    expect(db.insert).toHaveBeenCalled()
  })
})
