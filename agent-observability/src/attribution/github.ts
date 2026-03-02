import { Client } from '@modelcontextprotocol/sdk/client/index.js'

export interface PrInfo {
  number: number
  title: string
  url: string
  state: string
}

export async function findPrForBranch(
  client: Client,
  owner: string,
  repo: string,
  branch: string
): Promise<PrInfo | null> {
  try {
    const result = await client.callTool({
      name: 'search_pull_requests',
      arguments: { query: `repo:${owner}/${repo} head:${branch}` },
    })
    const text = (result.content as any[])[0]?.text
    if (!text) return null

    const data = JSON.parse(text)
    const pr = data.items?.[0]
    if (!pr) return null

    return {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      state: pr.state,
    }
  } catch {
    return null
  }
}
