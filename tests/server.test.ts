import { describe, it, expect, afterAll } from 'vitest'
import { startCoordServer } from '../src/server/index.js'
import type { Server } from 'http'

describe('coord server', () => {
  let httpServer: Server | undefined

  afterAll(async () => {
    await new Promise<void>(resolve => httpServer?.close(() => resolve()))
  })

  it('starts and returns port', async () => {
    const result = await startCoordServer({ port: 7499, dbPath: ':memory:' })
    httpServer = result.httpServer
    expect(result.port).toBe(7499)
  })
})
