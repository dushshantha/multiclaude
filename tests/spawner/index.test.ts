import { describe, it, expect } from 'vitest'
import { buildWorkerMcpConfig, buildWorkerArgs, buildWorkerEnv, writeWorkerMcpConfig } from '../../src/spawner/index.js'
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
      agentId: 'w-task-1',
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
      agentId: 'w-task-1',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    const prompt = args[args.length - 1]
    expect(prompt).toContain('Build JWT auth')
  })

  it('buildWorkerArgs includes agent_id in the prompt', () => {
    const args = buildWorkerArgs({
      taskId: 'task-1',
      taskTitle: 'Build auth',
      taskDescription: 'JWT impl',
      agentId: 'w-task-1',
      worktreePath: '/tmp/wt',
      mcpConfigPath: '/tmp/config.json',
    })
    const prompt = args[args.length - 1]
    expect(prompt).toContain('w-task-1')
  })

  it('buildWorkerEnv sets MULTICLAUDE_AGENT_ID', () => {
    const env = buildWorkerEnv('w-task-1')
    expect(env['MULTICLAUDE_AGENT_ID']).toBe('w-task-1')
  })
})
