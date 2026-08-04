import { describe, it, expect, afterAll } from 'vitest'
import { startCoordServer } from '../src/server/index.js'
import type { Server } from 'http'

const GIT_TOOLS = ['git_status', 'push_run_branch', 'create_pr', 'resolve_merge_conflict']

// Helper: retrieve the MCP tool list from an endpoint using the Streamable HTTP
// protocol (POST initialize + tools/list in a single session).
async function listMcpTools(baseUrl: string, path: string, token?: string): Promise<string[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  // Send initialize request — creates a new session
  const initRes = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.1' },
      },
    }),
  })

  const sessionId = initRes.headers.get('mcp-session-id')
  if (!sessionId) throw new Error('No mcp-session-id returned from initialize')

  // Drain the SSE stream from initialize (the server opens one but we just need session id)
  await initRes.body?.cancel()

  const listHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'mcp-session-id': sessionId,
  }
  if (token) listHeaders['Authorization'] = `Bearer ${token}`

  const listRes = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: listHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  })

  // The response may be SSE (text/event-stream) — read until we get the tools/list result
  const contentType = listRes.headers.get('content-type') ?? ''
  let payload: string

  if (contentType.includes('text/event-stream')) {
    const reader = listRes.body!.getReader()
    const decoder = new TextDecoder()
    let accumulated = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      accumulated += decoder.decode(value, { stream: true })
      // Each SSE event is terminated by a blank line; look for the data line
      const dataMatch = accumulated.match(/^data:\s*(.+)$/m)
      if (dataMatch) {
        payload = dataMatch[1]
        reader.cancel()
        break
      }
    }
    payload = payload!
  } else {
    payload = await listRes.text()
  }

  const parsed = JSON.parse(payload)
  const tools: Array<{ name: string }> = parsed?.result?.tools ?? []
  return tools.map(t => t.name)
}

describe('MCP tool registration', () => {
  let httpServer: Server | undefined
  let port: number

  afterAll(async () => {
    await new Promise<void>(resolve => httpServer?.close(() => resolve()))
  })

  it('starts server', async () => {
    const result = await startCoordServer({ port: 0 as any, dbPath: ':memory:' })
    httpServer = result.httpServer
    port = result.port
    expect(port).toBeGreaterThan(0)
  })

  it('git tools are registered on /orchestrator endpoint', async () => {
    const baseUrl = `http://localhost:${port}`
    // Get a bearer token via the auto-approve OAuth flow
    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'test-client',
      }),
    })
    // The auto-approve provider may not support client_credentials directly;
    // just pass any bearer token since verifyAccessToken accepts everything.
    const token = tokenRes.ok ? (await tokenRes.json() as { access_token: string }).access_token : 'test-token'

    const tools = await listMcpTools(baseUrl, '/orchestrator', token)
    for (const name of GIT_TOOLS) {
      expect(tools, `Expected ${name} to be registered on /orchestrator`).toContain(name)
    }
  })

  it('git tools are NOT present on /worker endpoint', async () => {
    const baseUrl = `http://localhost:${port}`
    const tools = await listMcpTools(baseUrl, '/worker')
    for (const name of GIT_TOOLS) {
      expect(tools, `Expected ${name} to be absent from /worker`).not.toContain(name)
    }
  })
})
