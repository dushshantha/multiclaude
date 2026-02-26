import { startCoordServer } from './server/index.js'
import { startWebServer } from './web/server.js'
import { startTui } from './tui/index.js'
import { writeWorkerMcpConfig } from './spawner/index.js'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

async function main() {
  const args = process.argv.slice(2)
  const noTui = args.includes('--no-tui')
  const noWeb = args.includes('--no-web')
  const coordPortArg = args.find(a => a.startsWith('--coord-port='))
  const webPortArg = args.find(a => a.startsWith('--web-port='))
  const coordPort = coordPortArg ? parseInt(coordPortArg.split('=')[1]) : 7432
  const webPort = webPortArg ? parseInt(webPortArg.split('=')[1]) : 7433

  console.log('Starting MultiClaude...')

  const { db, port } = await startCoordServer({ port: coordPort })
  console.log(`Coordination server: http://localhost:${port}`)

  // Write worker MCP config
  const mcpConfigPath = writeWorkerMcpConfig(port)

  // Write orchestrator MCP config
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '.'
  const claudeDir = join(homeDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  const orchestratorConfigPath = join(claudeDir, 'multiclaude-orchestrator-mcp.json')
  const orchestratorConfig = {
    mcpServers: {
      'multiclaude-coord': {
        type: 'http',
        url: `http://localhost:${port}/orchestrator`,
      }
    }
  }
  writeFileSync(orchestratorConfigPath, JSON.stringify(orchestratorConfig, null, 2))

  if (!noWeb) {
    startWebServer(db, webPort)
    console.log(`Web dashboard: http://localhost:${webPort}`)
  }

  console.log(`\nTo launch the orchestrator:\n  claude --mcp-config ${orchestratorConfigPath}`)
  console.log(`\nNote: ports 7432 (coord) and 7433 (web) are reserved — avoid killing them in agent tasks.\n`)

  // suppress unused variable warning
  void mcpConfigPath

  if (!noTui) {
    startTui(db)
  } else {
    console.log('MultiClaude running. Press Ctrl+C to stop.')
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
