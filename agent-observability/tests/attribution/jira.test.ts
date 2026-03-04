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
