import { describe, it, expect, vi } from 'vitest'
import { findPrForBranch } from '../../src/attribution/github.js'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

function makeMockClient(callToolResult: unknown) {
  return {
    callTool: vi.fn().mockResolvedValue(callToolResult),
  } as unknown as Client
}

describe('findPrForBranch', () => {
  it('returns PR info when a PR exists for the branch', async () => {
    const mockClient = makeMockClient({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            items: [
              {
                number: 42,
                title: 'feat: add new feature',
                html_url: 'https://github.com/owner/repo/pull/42',
                state: 'open',
              },
            ],
          }),
        },
      ],
    })

    const result = await findPrForBranch(mockClient, 'owner', 'repo', 'feat/my-branch')

    expect(result).toEqual({
      number: 42,
      title: 'feat: add new feature',
      url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
    })
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: 'search_pull_requests',
      arguments: { query: 'repo:owner/repo head:feat/my-branch' },
    })
  })

  it('returns null when no PR is found for the branch', async () => {
    const mockClient = makeMockClient({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ items: [] }),
        },
      ],
    })

    const result = await findPrForBranch(mockClient, 'owner', 'repo', 'feat/no-pr-branch')

    expect(result).toBeNull()
  })
})
