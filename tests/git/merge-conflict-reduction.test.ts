import { describe, it, expect, beforeEach } from 'vitest'
import { ensureIntegrationBranch, mergeWorktreeBranch, MergeConflictError, isAutoResolvable } from '../../src/git/merge.js'
import { createWorktree, removeWorktree } from '../../src/git/worktree.js'
import { execSync } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { useTempDir } from '../helpers/temp.js'

describe('isAutoResolvable', () => {
  it('identifies standard lockfiles', () => {
    expect(isAutoResolvable('package-lock.json')).toBe(true)
    expect(isAutoResolvable('yarn.lock')).toBe(true)
    expect(isAutoResolvable('pnpm-lock.yaml')).toBe(true)
    expect(isAutoResolvable('Gemfile.lock')).toBe(true)
    expect(isAutoResolvable('Cargo.lock')).toBe(true)
    expect(isAutoResolvable('poetry.lock')).toBe(true)
    expect(isAutoResolvable('composer.lock')).toBe(true)
    expect(isAutoResolvable('Pipfile.lock')).toBe(true)
    expect(isAutoResolvable('go.sum')).toBe(true)
    expect(isAutoResolvable('go.mod')).toBe(true)
    expect(isAutoResolvable('bun.lockb')).toBe(true)
  })

  it('identifies lockfiles by .lock extension', () => {
    expect(isAutoResolvable('some-custom.lock')).toBe(true)
    expect(isAutoResolvable('flake.lock')).toBe(true)
  })

  it('handles nested paths', () => {
    expect(isAutoResolvable('packages/web/package-lock.json')).toBe(true)
    expect(isAutoResolvable('services/api/yarn.lock')).toBe(true)
  })

  it('rejects source code files', () => {
    expect(isAutoResolvable('src/index.ts')).toBe(false)
    expect(isAutoResolvable('package.json')).toBe(true) // package.json IS auto-resolvable
    expect(isAutoResolvable('README.md')).toBe(false)
    expect(isAutoResolvable('src/utils.js')).toBe(false)
    expect(isAutoResolvable('test/app.test.ts')).toBe(false)
  })
})

describe('update-before-merge', () => {
  const tmp = useTempDir()
  let repoPath: string

  beforeEach(() => {
    repoPath = tmp.repo('mc-conflict-reduction-')
  })

  it('updates task branch with integration changes before assembly merge', async () => {
    const runId = 'update-test'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    // First task merges into integration
    const info1 = await createWorktree(repoPath, 'task-up-1')
    tmp.trackWorktree(info1, repoPath)
    writeFileSync(join(info1.path, 'first.ts'), 'export const first = 1')
    execSync('git add . && git commit -m "add first"', { cwd: info1.path })
    await mergeWorktreeBranch(repoPath, info1.branch, runId)
    await removeWorktree(repoPath, info1)

    // Second task: branched from main (stale — doesn't have first.ts)
    const info2 = await createWorktree(repoPath, 'task-up-2')
    tmp.trackWorktree(info2, repoPath)
    writeFileSync(join(info2.path, 'second.ts'), 'export const second = 2')
    execSync('git add . && git commit -m "add second"', { cwd: info2.path })

    await mergeWorktreeBranch(repoPath, info2.branch, runId, info2.path)

    // After the update step, task branch should contain first.ts
    const taskHasFirst = execSync(`git show ${info2.branch}:first.ts`, { cwd: repoPath }).toString()
    expect(taskHasFirst).toContain('export const first = 1')

    // Integration branch should have both files
    const intFirst = execSync(`git show ${integBranch}:first.ts`, { cwd: repoPath }).toString()
    const intSecond = execSync(`git show ${integBranch}:second.ts`, { cwd: repoPath }).toString()
    expect(intFirst).toContain('export const first = 1')
    expect(intSecond).toContain('export const second = 2')

    await removeWorktree(repoPath, info2)
  })

  it('skips update when integration has not diverged from task branch', async () => {
    const runId = 'no-update'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    // Task branched from same point as integration — no update needed
    const info = await createWorktree(repoPath, 'task-same-base')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'feature.ts'), 'export const x = 1')
    execSync('git add . && git commit -m "add feature"', { cwd: info.path })

    // Should merge cleanly without needing an update
    await expect(mergeWorktreeBranch(repoPath, info.branch, runId)).resolves.not.toThrow()

    const content = execSync(`git show ${integBranch}:feature.ts`, { cwd: repoPath }).toString()
    expect(content).toContain('export const x = 1')

    await removeWorktree(repoPath, info)
  })

  it('handles three sequential merges with stale task branches', { timeout: 15000 }, async () => {
    const runId = 'three-tasks'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    // All three tasks branch from main simultaneously (before any merges)
    const info1 = await createWorktree(repoPath, 'task-3a')
    tmp.trackWorktree(info1, repoPath)
    writeFileSync(join(info1.path, 'a.ts'), 'export const a = 1')
    execSync('git add . && git commit -m "add a"', { cwd: info1.path })

    const info2 = await createWorktree(repoPath, 'task-3b')
    tmp.trackWorktree(info2, repoPath)
    writeFileSync(join(info2.path, 'b.ts'), 'export const b = 2')
    execSync('git add . && git commit -m "add b"', { cwd: info2.path })

    const info3 = await createWorktree(repoPath, 'task-3c')
    tmp.trackWorktree(info3, repoPath)
    writeFileSync(join(info3.path, 'c.ts'), 'export const c = 3')
    execSync('git add . && git commit -m "add c"', { cwd: info3.path })

    // Merge sequentially — each subsequent merge faces a stale task branch
    await mergeWorktreeBranch(repoPath, info1.branch, runId, info1.path)
    await mergeWorktreeBranch(repoPath, info2.branch, runId, info2.path)
    await mergeWorktreeBranch(repoPath, info3.branch, runId, info3.path)

    // All files should be in integration
    expect(execSync(`git show ${integBranch}:a.ts`, { cwd: repoPath }).toString()).toContain('export const a = 1')
    expect(execSync(`git show ${integBranch}:b.ts`, { cwd: repoPath }).toString()).toContain('export const b = 2')
    expect(execSync(`git show ${integBranch}:c.ts`, { cwd: repoPath }).toString()).toContain('export const c = 3')

    // Task branches should be updated with prior tasks' changes
    expect(execSync(`git show ${info2.branch}:a.ts`, { cwd: repoPath }).toString()).toContain('export const a = 1')
    expect(execSync(`git show ${info3.branch}:a.ts`, { cwd: repoPath }).toString()).toContain('export const a = 1')
    expect(execSync(`git show ${info3.branch}:b.ts`, { cwd: repoPath }).toString()).toContain('export const b = 2')

    await removeWorktree(repoPath, info1)
    await removeWorktree(repoPath, info2)
    await removeWorktree(repoPath, info3)
  })
})

describe('extended auto-resolution', () => {
  const tmp = useTempDir()
  let repoPath: string

  beforeEach(() => {
    repoPath = tmp.repo('mc-conflict-reduction-')
  })

  it('auto-resolves yarn.lock add/add conflict', async () => {
    const runId = 'yarn-lock'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    // Add yarn.lock on integration branch
    const origBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'yarn.lock'), '# yarn lockfile v1\nresolved "integ"')
    execSync('git add . && git commit -m "add yarn.lock on integ"', { cwd: repoPath })
    execSync(`git checkout ${origBranch}`, { cwd: repoPath })

    // Create worktree with different yarn.lock
    const info = await createWorktree(repoPath, 'task-yarn')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'yarn.lock'), '# yarn lockfile v1\nresolved "worker"')
    writeFileSync(join(info.path, 'feature.ts'), 'export const f = 1')
    execSync('git add . && git commit -m "add yarn.lock + feature"', { cwd: info.path })

    await expect(mergeWorktreeBranch(repoPath, info.branch, runId)).resolves.not.toThrow()

    // Feature file should be in integration
    const feature = execSync(`git show ${integBranch}:feature.ts`, { cwd: repoPath }).toString()
    expect(feature).toContain('export const f = 1')

    await removeWorktree(repoPath, info)
  })

  it('auto-resolves pnpm-lock.yaml add/add conflict', async () => {
    const runId = 'pnpm-lock'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    const origBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4\nintegration: true')
    execSync('git add . && git commit -m "add pnpm-lock on integ"', { cwd: repoPath })
    execSync(`git checkout ${origBranch}`, { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-pnpm')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4\nworker: true')
    execSync('git add . && git commit -m "add pnpm-lock"', { cwd: info.path })

    await expect(mergeWorktreeBranch(repoPath, info.branch, runId)).resolves.not.toThrow()

    await removeWorktree(repoPath, info)
  })

  it('auto-resolves Cargo.lock conflict', async () => {
    const runId = 'cargo-lock'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    const origBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'Cargo.lock'), '[[package]]\nname = "integ"')
    execSync('git add . && git commit -m "add Cargo.lock on integ"', { cwd: repoPath })
    execSync(`git checkout ${origBranch}`, { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-cargo')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'Cargo.lock'), '[[package]]\nname = "worker"')
    execSync('git add . && git commit -m "add Cargo.lock"', { cwd: info.path })

    await expect(mergeWorktreeBranch(repoPath, info.branch, runId)).resolves.not.toThrow()

    await removeWorktree(repoPath, info)
  })

  it('auto-resolves lockfile conflict alongside source code (no conflict in source)', async () => {
    const runId = 'mixed-lock'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    const origBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'package-lock.json'), '{"integ": true}')
    writeFileSync(join(repoPath, 'integ-only.ts'), 'export const integ = 1')
    execSync('git add . && git commit -m "integ changes"', { cwd: repoPath })
    execSync(`git checkout ${origBranch}`, { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-mixed')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'package-lock.json'), '{"worker": true}')
    writeFileSync(join(info.path, 'worker-only.ts'), 'export const worker = 1')
    execSync('git add . && git commit -m "worker changes"', { cwd: info.path })

    await expect(mergeWorktreeBranch(repoPath, info.branch, runId)).resolves.not.toThrow()

    // Both source files should be present
    expect(execSync(`git show ${integBranch}:integ-only.ts`, { cwd: repoPath }).toString()).toContain('export const integ = 1')
    expect(execSync(`git show ${integBranch}:worker-only.ts`, { cwd: repoPath }).toString()).toContain('export const worker = 1')

    await removeWorktree(repoPath, info)
  })
})

describe('unresolvable conflict failure', () => {
  const tmp = useTempDir()
  let repoPath: string

  beforeEach(() => {
    repoPath = tmp.repo('mc-conflict-reduction-')
  })

  it('throws MergeConflictError with file paths for source code conflicts', async () => {
    const runId = 'src-conflict'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    const origBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'conflict.ts'), 'export const value = "integration"')
    execSync('git add . && git commit -m "integ side"', { cwd: repoPath })
    execSync(`git checkout ${origBranch}`, { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-src-conflict')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'conflict.ts'), 'export const value = "worker"')
    execSync('git add . && git commit -m "worker side"', { cwd: info.path })

    try {
      await mergeWorktreeBranch(repoPath, info.branch, runId)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(MergeConflictError)
      const conflict = err as MergeConflictError
      expect(conflict.conflictedFiles).toContain('conflict.ts')
      expect(conflict.message).toContain('conflict.ts')
    }

    await removeWorktree(repoPath, info)
  })

  it('auto-resolves lockfile but fails on source conflict in the same merge', async () => {
    const runId = 'partial-resolve'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    const origBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'package-lock.json'), '{"integ": true}')
    writeFileSync(join(repoPath, 'conflict.ts'), 'export const x = "integ"')
    execSync('git add . && git commit -m "integ side"', { cwd: repoPath })
    execSync(`git checkout ${origBranch}`, { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-partial')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'package-lock.json'), '{"worker": true}')
    writeFileSync(join(info.path, 'conflict.ts'), 'export const x = "worker"')
    execSync('git add . && git commit -m "worker side"', { cwd: info.path })

    try {
      await mergeWorktreeBranch(repoPath, info.branch, runId)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(MergeConflictError)
      const conflict = err as MergeConflictError
      // Only source code conflict should be reported, not the lockfile
      expect(conflict.conflictedFiles).toContain('conflict.ts')
      expect(conflict.conflictedFiles).not.toContain('package-lock.json')
    }

    await removeWorktree(repoPath, info)
  })

  it('leaves integration branch unchanged when conflict cannot be resolved', async () => {
    const runId = 'clean-after-fail'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    const origBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'x.ts'), 'integ')
    execSync('git add . && git commit -m "integ"', { cwd: repoPath })
    const headBefore = execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${origBranch}`, { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-clean-fail')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'x.ts'), 'worker')
    execSync('git add . && git commit -m "worker"', { cwd: info.path })

    await expect(mergeWorktreeBranch(repoPath, info.branch, runId)).rejects.toThrow(MergeConflictError)

    const headAfter = execSync(`git rev-parse ${integBranch}`, { cwd: repoPath }).toString().trim()
    expect(headAfter).toBe(headBefore)

    await removeWorktree(repoPath, info)
  })
})

describe('serialization guarantee', () => {
  const tmp = useTempDir()
  let repoPath: string

  beforeEach(() => {
    repoPath = tmp.repo('mc-conflict-reduction-')
  })

  it('concurrent merges with update-before-merge both succeed', async () => {
    const runId = 'concurrent-update'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    const info1 = await createWorktree(repoPath, 'task-cu-1')
    tmp.trackWorktree(info1, repoPath)
    writeFileSync(join(info1.path, 'a.ts'), 'export const a = 1')
    execSync('git add . && git commit -m "add a"', { cwd: info1.path })

    const info2 = await createWorktree(repoPath, 'task-cu-2')
    tmp.trackWorktree(info2, repoPath)
    writeFileSync(join(info2.path, 'b.ts'), 'export const b = 2')
    execSync('git add . && git commit -m "add b"', { cwd: info2.path })

    // Fire both merges concurrently — serialization ensures correctness
    await Promise.all([
      mergeWorktreeBranch(repoPath, info1.branch, runId, info1.path),
      mergeWorktreeBranch(repoPath, info2.branch, runId, info2.path),
    ])

    // Both files should be present
    expect(execSync(`git show ${integBranch}:a.ts`, { cwd: repoPath }).toString()).toContain('export const a = 1')
    expect(execSync(`git show ${integBranch}:b.ts`, { cwd: repoPath }).toString()).toContain('export const b = 2')

    await removeWorktree(repoPath, info1)
    await removeWorktree(repoPath, info2)
  })

  it('concurrent merges with lockfile conflicts both succeed via auto-resolution', async () => {
    const runId = 'concurrent-lock'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    const info1 = await createWorktree(repoPath, 'task-cl-1')
    tmp.trackWorktree(info1, repoPath)
    writeFileSync(join(info1.path, 'package-lock.json'), '{"task1": true}')
    writeFileSync(join(info1.path, 'feat1.ts'), 'export const f1 = 1')
    execSync('git add . && git commit -m "task1 changes"', { cwd: info1.path })

    const info2 = await createWorktree(repoPath, 'task-cl-2')
    tmp.trackWorktree(info2, repoPath)
    writeFileSync(join(info2.path, 'package-lock.json'), '{"task2": true}')
    writeFileSync(join(info2.path, 'feat2.ts'), 'export const f2 = 2')
    execSync('git add . && git commit -m "task2 changes"', { cwd: info2.path })

    // Both tasks add package-lock.json — auto-resolution should handle it
    await Promise.all([
      mergeWorktreeBranch(repoPath, info1.branch, runId, info1.path),
      mergeWorktreeBranch(repoPath, info2.branch, runId, info2.path),
    ])

    // Both feature files should be present
    expect(execSync(`git show ${integBranch}:feat1.ts`, { cwd: repoPath }).toString()).toContain('export const f1 = 1')
    expect(execSync(`git show ${integBranch}:feat2.ts`, { cwd: repoPath }).toString()).toContain('export const f2 = 2')

    await removeWorktree(repoPath, info1)
    await removeWorktree(repoPath, info2)
  })
})
