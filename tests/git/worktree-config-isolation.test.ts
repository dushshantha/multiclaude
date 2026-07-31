import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorktree, removeWorktree, sanitizeParentGitConfig, assertSharedConfigClean } from '../../src/git/worktree.js'
import { buildWorkerEnv } from '../../src/spawner/index.js'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function git(cmd: string, cwd: string, env?: NodeJS.ProcessEnv): string {
  return execSync(cmd, { cwd, env, encoding: 'utf8' }).trim()
}

describe('worktree config isolation (#100)', () => {
  let parentRepo: string
  let savedGitEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedGitEnv = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
    }
    delete process.env.GIT_DIR
    delete process.env.GIT_WORK_TREE
    delete process.env.GIT_CEILING_DIRECTORIES

    parentRepo = realpathSync(mkdtempSync(join(tmpdir(), 'mc-config-iso-test-')))
    git('git init', parentRepo)
    git('git config user.email "test@test.com"', parentRepo)
    git('git config user.name "Test"', parentRepo)
    git('echo "init" > README.md && git add . && git commit -m "init"', parentRepo)
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(savedGitEnv)) {
      if (val !== undefined) process.env[key] = val
      else delete process.env[key]
    }
    rmSync(parentRepo, { recursive: true, force: true })
  })

  it('parent repo resolves toplevel and is-inside-work-tree after worktree create+delete', async () => {
    const info = await createWorktree(parentRepo, 'cfg-1', 'feat: config test')
    await removeWorktree(parentRepo, info)

    expect(git('git rev-parse --is-inside-work-tree', parentRepo)).toBe('true')
    expect(git('git rev-parse --show-toplevel', parentRepo)).toBe(parentRepo)
  })

  it('parent .git/config is byte-identical before and after full worktree lifecycle', async () => {
    const configPath = join(parentRepo, '.git', 'config')
    const configBefore = readFileSync(configPath, 'utf8')

    const info = await createWorktree(parentRepo, 'cfg-2', 'feat: byte identical')
    const env = buildWorkerEnv('w-cfg-2', { worktreePath: info.path, gitDir: info.gitDir })

    writeFileSync(join(info.path, 'feature.ts'), 'export const x = 1')
    git('git add feature.ts && git commit -m "add feature"', info.path, env)

    await removeWorktree(parentRepo, info)

    const configAfter = readFileSync(configPath, 'utf8')
    expect(configAfter).toBe(configBefore)
  })

  it('worker with isolation env vars cannot commit to parent repo branch (#96)', async () => {
    const info = await createWorktree(parentRepo, 'cfg-3', 'feat: isolation check')
    const env = buildWorkerEnv('w-cfg-3', { worktreePath: info.path, gitDir: info.gitDir })

    writeFileSync(join(info.path, 'isolated.ts'), 'export const isolated = true')
    git('git add isolated.ts && git commit -m "isolated commit"', info.path, env)

    expect(git(`git log --oneline ${info.branch}`, parentRepo)).toContain('isolated commit')

    const parentBranch = git('git branch --show-current', parentRepo)
    expect(git(`git log --oneline ${parentBranch}`, parentRepo)).not.toContain('isolated commit')

    await removeWorktree(parentRepo, info)
  })

  it('removeWorktree cleans up stray core.worktree from parent config', async () => {
    const info = await createWorktree(parentRepo, 'cfg-4', 'feat: cleanup test')

    git(`git config --local core.worktree "${info.path}"`, parentRepo)
    expect(git('git config --local --get core.worktree', parentRepo)).toBe(info.path)

    await removeWorktree(parentRepo, info)

    expect(git('git rev-parse --is-inside-work-tree', parentRepo)).toBe('true')
    expect(git('git rev-parse --show-toplevel', parentRepo)).toBe(parentRepo)

    let coreWorktree: string | null = null
    try {
      coreWorktree = git('git config --local --get core.worktree', parentRepo)
    } catch {
      // exit code 1 = key not found — expected
    }
    expect(coreWorktree).toBeNull()
  })

  it('sanitizeParentGitConfig removes stray core.worktree', async () => {
    git('git config --local core.worktree "/tmp/deleted-worktree"', parentRepo)
    expect(git('git config --local --get core.worktree', parentRepo)).toBe('/tmp/deleted-worktree')

    await sanitizeParentGitConfig(parentRepo)

    let after: string | null = null
    try {
      after = git('git config --local --get core.worktree', parentRepo)
    } catch { /* not set */ }
    expect(after).toBeNull()
  })

  it('sanitizeParentGitConfig is a no-op when config is clean', async () => {
    const configPath = join(parentRepo, '.git', 'config')
    const configBefore = readFileSync(configPath, 'utf8')

    await sanitizeParentGitConfig(parentRepo)

    const configAfter = readFileSync(configPath, 'utf8')
    expect(configAfter).toBe(configBefore)
  })

  it('assertSharedConfigClean throws when core.worktree is set', async () => {
    git('git config --local core.worktree "/tmp/bad-path"', parentRepo)
    await expect(assertSharedConfigClean(parentRepo)).rejects.toThrow('core.worktree')
  })

  it('assertSharedConfigClean passes when config is clean', async () => {
    await expect(assertSharedConfigClean(parentRepo)).resolves.toBeUndefined()
  })

  it('multiple worktree create+delete cycles leave parent config untouched', async () => {
    const configPath = join(parentRepo, '.git', 'config')
    const configBefore = readFileSync(configPath, 'utf8')

    for (let i = 0; i < 3; i++) {
      const info = await createWorktree(parentRepo, `cfg-multi-${i}`, `feat: cycle ${i}`)
      const env = buildWorkerEnv(`w-cfg-multi-${i}`, { worktreePath: info.path, gitDir: info.gitDir })
      writeFileSync(join(info.path, `file-${i}.ts`), `export const x = ${i}`)
      git(`git add file-${i}.ts && git commit -m "commit ${i}"`, info.path, env)
      await removeWorktree(parentRepo, info)
    }

    const configAfter = readFileSync(configPath, 'utf8')
    expect(configAfter).toBe(configBefore)

    expect(git('git rev-parse --is-inside-work-tree', parentRepo)).toBe('true')
  })
})
