import { describe, it, expect } from 'vitest'
import { buildWorkerMcpConfig, buildWorkerArgs, buildWorkerEnv, writeWorkerMcpConfig } from '../../src/spawner/index.js'
import type { SpawnConfig } from '../../src/spawner/index.js'

describe('spawner', () => {
  it('buildWorkerMcpConfig uses multiclaude-worker (not coord) to avoid naming conflict', () => {
    const config = buildWorkerMcpConfig({ serverPort: 7432 })
    expect(config.mcpServers).toHaveProperty('multiclaude-worker')
    expect(config.mcpServers['multiclaude-worker'].url).toContain('7432')
    expect(config.mcpServers['multiclaude-worker'].url).toContain('/worker')
    // Should NOT use 'multiclaude-coord' — that name is reserved for the orchestrator endpoint
    expect(config.mcpServers).not.toHaveProperty('multiclaude-coord')
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

  it('buildWorkerArgs uses --output-format text for human-readable terminal output', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build JWT auth',
      agentId: 'w-task-1',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    expect(args).toContain('--print')
    expect(args).not.toContain('--verbose')
    expect(args).toContain('--output-format')
    expect(args[args.indexOf('--output-format') + 1]).toBe('text')
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

  it('buildWorkerEnv removes CLAUDECODE to prevent nested session error', () => {
    const orig = process.env['CLAUDECODE']
    process.env['CLAUDECODE'] = '1'
    const env = buildWorkerEnv('w-task-1')
    expect(env['CLAUDECODE']).toBeUndefined()
    if (orig === undefined) delete process.env['CLAUDECODE']
    else process.env['CLAUDECODE'] = orig
  })
})
