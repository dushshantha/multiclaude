import { Client } from '@modelcontextprotocol/sdk/client/index.js'

export interface TicketSummary {
  id: string
  storyPoints: number | null
  status: string
}

// Extract Jira-style ticket ID from branch name (e.g. feat/PROJ-123 → PROJ-123)
function extractTicketId(branch: string): string | null {
  const match = branch.match(/([A-Z]+-\d+)/i)
  return match ? match[1].toUpperCase() : null
}

export async function findTicketForBranch(
  client: Client,
  branch: string
): Promise<TicketSummary | null> {
  const ticketId = extractTicketId(branch)
  if (!ticketId) return null

  try {
    const result = await client.callTool({ name: 'get_issue', arguments: { issue_key: ticketId } })
    const text = (result.content as any[])[0]?.text
    if (!text) return null

    const issue = JSON.parse(text)
    return {
      id: issue.key,
      storyPoints: issue.fields?.story_points ?? null,
      status: issue.fields?.status?.name ?? 'unknown',
    }
  } catch {
    return null
  }
}
