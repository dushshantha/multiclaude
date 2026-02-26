import { describe, it, expect } from 'vitest'
import { buildWorkerMcpConfig, buildWorkerArgs } from '../../src/spawner/index.js'
import type { SpawnConfig } from '../../src/spawner/index.js'

describe('spawner', () => {
  it('buildWorkerMcpConfig includes the coord server', () => {
    const config = buildWorkerMcpConfig({ serverPort: 7432 })
    expect(config.mcpServers).toHaveProperty('multiclaude-coord')
    expect(config.mcpServers['multiclaude-coord'].url).toContain('7432')
  })

  it('buildWorkerArgs includes --mcp-config flag', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build JWT auth',
      taskDescription: 'Implement JWT refresh token logic',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    expect(args).toContain('--mcp-config')
    expect(args).toContain('/tmp/mc-worker-config.json')
  })

  it('buildWorkerArgs prompt includes task title', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build JWT auth',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    const prompt = args[args.length - 1]
    expect(prompt).toContain('Build JWT auth')
  })
})
