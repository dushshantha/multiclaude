import { describe, it, expect } from 'vitest'
import { buildWorkerMcpConfig, buildWorkerArgs, buildWorkerEnv, buildWorkerSettings, resolveHookCommand, writeWorkerMcpConfig } from '../../src/spawner/index.js'
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

  it('buildWorkerArgs uses stream-json by default for token capture via log parsing', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build JWT auth',
      agentId: 'w-task-1',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    expect(args).toContain('--print')
    expect(args).toContain('--verbose')
    expect(args).toContain('--output-format')
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
  })

  it('buildWorkerArgs uses text format when openTerminals=true for human-readable terminal output', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build JWT auth',
      agentId: 'w-task-1',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
      openTerminals: true,
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

  it('buildWorkerEnv sets MULTICLAUDE_WORKTREE from isolation.worktreePath', () => {
    const env = buildWorkerEnv('w-task-1', {
      worktreePath: '/tmp/mc-task-1-abcdef',
      gitDir: '/repos/.git/worktrees/mc-task-1-abcdef',
    })
    expect(env['MULTICLAUDE_WORKTREE']).toBe('/tmp/mc-task-1-abcdef')
  })

  it('buildWorkerEnv sets MULTICLAUDE_WORKTREE from opts.worktreePath when no isolation', () => {
    const env = buildWorkerEnv('w-task-1', undefined, { worktreePath: '/tmp/mc-task-fallback' })
    expect(env['MULTICLAUDE_WORKTREE']).toBe('/tmp/mc-task-fallback')
  })

  it('buildWorkerEnv omits MULTICLAUDE_WORKTREE when neither isolation nor opts provided', () => {
    const saved = process.env.MULTICLAUDE_WORKTREE
    delete process.env.MULTICLAUDE_WORKTREE
    try {
      const env = buildWorkerEnv('w-task-1')
      expect(env['MULTICLAUDE_WORKTREE']).toBeUndefined()
    } finally {
      if (saved !== undefined) process.env.MULTICLAUDE_WORKTREE = saved
    }
  })

  it('buildWorkerEnv sets MULTICLAUDE_TASK_ID from opts.taskId', () => {
    const env = buildWorkerEnv('w-task-1', undefined, { taskId: 'my-task-123' })
    expect(env['MULTICLAUDE_TASK_ID']).toBe('my-task-123')
  })

  it('buildWorkerEnv omits MULTICLAUDE_TASK_ID when not provided', () => {
    const saved = process.env.MULTICLAUDE_TASK_ID
    delete process.env.MULTICLAUDE_TASK_ID
    try {
      const env = buildWorkerEnv('w-task-1')
      expect(env['MULTICLAUDE_TASK_ID']).toBeUndefined()
    } finally {
      if (saved !== undefined) process.env.MULTICLAUDE_TASK_ID = saved
    }
  })

  it('buildWorkerArgs passes --model with correct model ID for sonnet (default)', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build JWT auth',
      agentId: 'w-task-1',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6')
  })

  it('buildWorkerArgs passes --model with correct model ID for haiku', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build JWT auth',
      model: 'haiku',
      agentId: 'w-task-1',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5-20251001')
  })

  it('buildWorkerArgs passes --model with correct model ID for opus', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build JWT auth',
      model: 'opus',
      agentId: 'w-task-1',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-6')
  })

  it('buildWorkerEnv removes CLAUDECODE to prevent nested session error', () => {
    const orig = process.env['CLAUDECODE']
    process.env['CLAUDECODE'] = '1'
    const env = buildWorkerEnv('w-task-1')
    expect(env['CLAUDECODE']).toBeUndefined()
    if (orig === undefined) delete process.env['CLAUDECODE']
    else process.env['CLAUDECODE'] = orig
  })

  it('buildWorkerEnv sets GIT_DIR, GIT_WORK_TREE, GIT_CEILING_DIRECTORIES when isolation provided', () => {
    const env = buildWorkerEnv('w-task-1', {
      worktreePath: '/tmp/mc-task-1-abcdef',
      gitDir: '/repos/.git/worktrees/mc-task-1-abcdef',
    })
    expect(env.GIT_DIR).toBe('/repos/.git/worktrees/mc-task-1-abcdef')
    expect(env.GIT_WORK_TREE).toBe('/tmp/mc-task-1-abcdef')
    expect(env.GIT_CEILING_DIRECTORIES).toBe('/tmp')
  })

  it('buildWorkerEnv omits git isolation vars when no isolation provided', () => {
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
    }
    delete process.env.GIT_DIR
    delete process.env.GIT_WORK_TREE
    delete process.env.GIT_CEILING_DIRECTORIES
    try {
      const env = buildWorkerEnv('w-task-1')
      expect(env.GIT_DIR).toBeUndefined()
      expect(env.GIT_WORK_TREE).toBeUndefined()
      expect(env.GIT_CEILING_DIRECTORIES).toBeUndefined()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) (process.env as Record<string, string>)[k] = v
      }
    }
  })

  it('buildWorkerArgs omits --effort when effort is unset (high is the default)', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build auth',
      agentId: 'w-task-1',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    expect(args).not.toContain('--effort')
  })

  it('buildWorkerArgs omits --effort when effort is explicitly high (backwards-compatible default)', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build auth',
      effort: 'high',
      agentId: 'w-task-1',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    expect(args).not.toContain('--effort')
  })

  it('buildWorkerArgs passes --effort low for low effort', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build auth',
      effort: 'low',
      agentId: 'w-task-1',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    expect(args).toContain('--effort')
    expect(args[args.indexOf('--effort') + 1]).toBe('low')
  })

  it('buildWorkerArgs passes --effort max for max effort', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build auth',
      effort: 'max',
      agentId: 'w-task-1',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    expect(args).toContain('--effort')
    expect(args[args.indexOf('--effort') + 1]).toBe('max')
  })

  it('buildWorkerArgs passes --effort xhigh for xhigh effort', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build auth',
      effort: 'xhigh',
      agentId: 'w-task-1',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    expect(args).toContain('--effort')
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh')
  })
})

describe('buildWorkerSettings', () => {
  it('scopes Edit permission to the worktree path (Edit covers all file-editing tools including Write)', () => {
    const settings = buildWorkerSettings({ worktreePath: '/tmp/mc-test-worktree' }) as any
    expect(settings.permissions.allow).toContain('Edit(/tmp/mc-test-worktree/**)')
  })

  it('does not emit path-scoped Write rules (Claude Code ignores Write(path), only Edit(path) is matched)', () => {
    const settings = buildWorkerSettings({
      worktreePath: '/tmp/mc-test-worktree',
      repoPath: '/Users/alice/myproject',
    }) as any
    const allRules = [
      ...(settings.permissions.allow ?? []),
      ...(settings.permissions.deny ?? []),
    ]
    const pathScopedWrite = allRules.filter((r: string) => r.startsWith('Write(') && r !== 'Write(*)')
    expect(pathScopedWrite).toHaveLength(0)
  })

  it('keeps Read(*) as unrestricted (hook enforces boundary)', () => {
    const settings = buildWorkerSettings({ worktreePath: '/tmp/mc-test-worktree' }) as any
    expect(settings.permissions.allow).toContain('Read(*)')
  })

  it('keeps Bash(*) as unrestricted (cannot scope by path via globs)', () => {
    const settings = buildWorkerSettings({ worktreePath: '/tmp/mc-test-worktree' }) as any
    expect(settings.permissions.allow).toContain('Bash(*)')
  })

  it('does not include blanket Write(*) or Edit(*)', () => {
    const settings = buildWorkerSettings({ worktreePath: '/tmp/mc-test-worktree' }) as any
    expect(settings.permissions.allow).not.toContain('Write(*)')
    expect(settings.permissions.allow).not.toContain('Edit(*)')
  })

  it('includes all required worker MCP tools', () => {
    const settings = buildWorkerSettings({ worktreePath: '/tmp/mc-test-worktree' }) as any
    expect(settings.permissions.allow).toContain('mcp__multiclaude-worker__get_my_task')
    expect(settings.permissions.allow).toContain('mcp__multiclaude-worker__report_progress')
    expect(settings.permissions.allow).toContain('mcp__multiclaude-worker__report_done')
    expect(settings.permissions.allow).toContain('mcp__multiclaude-worker__report_blocked')
  })

  it('adds Edit deny rule for repoPath when provided (Edit covers all file-editing tools including Write)', () => {
    const settings = buildWorkerSettings({
      worktreePath: '/tmp/mc-test-worktree',
      repoPath: '/Users/alice/myproject',
    }) as any
    expect(settings.permissions.deny).toBeDefined()
    expect(settings.permissions.deny).toContain('Edit(/Users/alice/myproject/**)')
    expect(settings.permissions.deny).not.toContain('Write(/Users/alice/myproject/**)')
  })

  it('omits deny key when no repoPath is provided', () => {
    const settings = buildWorkerSettings({ worktreePath: '/tmp/mc-test-worktree' }) as any
    expect(settings.permissions.deny).toBeUndefined()
  })

  it('registers a PreToolUse hook entry', () => {
    const settings = buildWorkerSettings({ worktreePath: '/tmp/mc-test-worktree' }) as any
    expect(settings.hooks).toBeDefined()
    expect(settings.hooks.PreToolUse).toBeDefined()
    expect(Array.isArray(settings.hooks.PreToolUse)).toBe(true)
    expect(settings.hooks.PreToolUse.length).toBeGreaterThan(0)
    const entry = settings.hooks.PreToolUse[0]
    expect(entry.matcher).toBe('.*')
    expect(entry.hooks[0].type).toBe('command')
    expect(typeof entry.hooks[0].command).toBe('string')
    expect(entry.hooks[0].command.length).toBeGreaterThan(0)
  })
})

describe('resolveHookCommand', () => {
  it('returns a non-empty string', () => {
    const cmd = resolveHookCommand()
    expect(typeof cmd).toBe('string')
    expect(cmd.length).toBeGreaterThan(0)
  })

  it('command references the worktree-guard-hook file', () => {
    const cmd = resolveHookCommand()
    expect(cmd).toContain('worktree-guard-hook')
  })
})
