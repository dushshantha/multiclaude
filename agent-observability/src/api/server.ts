import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { Db } from '../db/index.js'
import { getOrgMetrics } from '../analytics/index.js'
import { listSessions } from '../sessions/index.js'

export async function buildApiServer(db: Db) {
  const app = Fastify({ logger: false })

  await app.register(cors)

  app.get('/health', async () => {
    return { ok: true }
  })

  app.get<{ Params: { orgId: string } }>('/orgs/:orgId/metrics', async (request) => {
    const { orgId } = request.params
    return getOrgMetrics(db, orgId)
  })

  app.get<{ Params: { orgId: string } }>('/orgs/:orgId/sessions', async (request) => {
    const { orgId } = request.params
    return listSessions(db, orgId)
  })

  return app
}
