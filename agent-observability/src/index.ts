import 'dotenv/config'
import { createDb } from './db/index.js'
import { createCollectionServer } from './collection/server.js'
import { buildApiServer } from './api/server.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('ERROR: DATABASE_URL environment variable is not set')
  process.exit(1)
}

const db = createDb(databaseUrl)

const { port: collectionPort } = await createCollectionServer(db)
const apiApp = await buildApiServer(db, collectionPort)

const API_PORT = Number(process.env.API_PORT ?? 3001)
await apiApp.listen({ port: API_PORT, host: '127.0.0.1' })

console.log(`Agent Observability Platform`)
console.log(`  Collection server (MCP): http://127.0.0.1:${collectionPort}/mcp`)
console.log(`  Analytics API:           http://127.0.0.1:${API_PORT}`)
console.log(`  Health check:            http://127.0.0.1:${API_PORT}/health`)
