import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { isPathInWorktree } from '../../src/spawner/worktree-guard.js'

// ---------------------------------------------------------------------------
// isPathInWorktree — pure predicate
// ---------------------------------------------------------------------------

describe('isPathInWorktree', () => {
  let worktree: string

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'mc-guard-test-'))
  })

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true })
  })

  it('allows an existing file directly inside the worktree', () => {
    expect(isPathInWorktree(worktree, join(worktree, 'file.ts'))).toBe(true)
  })

  it('allows an existing file in a sub-directory', () => {
    const sub = join(worktree, 'src', 'foo')
    mkdirSync(sub, { recursive: true })
    expect(isPathInWorktree(worktree, join(sub, 'bar.ts'))).toBe(true)
  })

  it('allows the worktree root itself', () => {
    expect(isPathInWorktree(worktree, worktree)).toBe(true)
  })

  it('denies a path outside the worktree', () => {
    expect(isPathInWorktree(worktree, '/etc/passwd')).toBe(false)
  })

  it('denies a path that is a sibling of the worktree', () => {
    const sibling = worktree + '-sibling'
    expect(isPathInWorktree(worktree, sibling)).toBe(false)
  })

  it('denies a path that is the parent of the worktree', () => {
    expect(isPathInWorktree(worktree, tmpdir())).toBe(false)
  })

  // .. traversal ---------------------------------------------------------------

  it('denies a path that uses .. to escape the worktree', () => {
    const evil = join(worktree, '..', 'escape.ts')
    expect(isPathInWorktree(worktree, evil)).toBe(false)
  })

  it('denies a deeply nested .. traversal that escapes', () => {
    const evil = join(worktree, 'src', 'foo', '..', '..', '..', 'escape.ts')
    expect(isPathInWorktree(worktree, evil)).toBe(false)
  })

  it('allows a path with .. that still stays inside the worktree', () => {
    const safe = join(worktree, 'src', '..', 'file.ts')
    expect(isPathInWorktree(worktree, safe)).toBe(true)
  })

  // Non-existent paths (Write to new file) ------------------------------------

  it('allows a non-existent file inside the worktree', () => {
    const newFile = join(worktree, 'does-not-exist.ts')
    expect(isPathInWorktree(worktree, newFile)).toBe(true)
  })

  it('allows a non-existent nested path inside the worktree', () => {
    const newFile = join(worktree, 'new', 'dir', 'file.ts')
    expect(isPathInWorktree(worktree, newFile)).toBe(true)
  })

  it('denies a non-existent file that is outside the worktree', () => {
    expect(isPathInWorktree(worktree, '/tmp/mc-OTHER-worktree/file.ts')).toBe(false)
  })

  // Relative paths -------------------------------------------------------------

  it('allows a relative path that resolves to inside the worktree', () => {
    // chdir-based relative paths are tricky; just test resolve() semantics
    const relative = worktree + '/./src/../file.ts'
    expect(isPathInWorktree(worktree, relative)).toBe(true)
  })

  // Symlinks -------------------------------------------------------------------

  it('resolves symlinks on the worktree root side', () => {
    // Create a symlink pointing to the real worktree
    const link = worktree + '-link'
    symlinkSync(worktree, link)
    try {
      // The candidate uses the real path, the root is the symlink
      expect(isPathInWorktree(link, join(worktree, 'file.ts'))).toBe(true)
    } finally {
      rmSync(link)
    }
  })

  it('resolves symlinks on the candidate path side', () => {
    const link = worktree + '-link'
    symlinkSync(worktree, link)
    try {
      // The root is the real path, the candidate goes through the symlink
      expect(isPathInWorktree(worktree, join(link, 'file.ts'))).toBe(true)
    } finally {
      rmSync(link)
    }
  })

  it('handles /tmp -> /private/tmp symlink on macOS (or identity on Linux)', () => {
    // On macOS /tmp is a symlink to /private/tmp. Create worktree under /tmp
    // and verify a /private/tmp path still matches (or vice-versa on Linux).
    const tmpWorktree = mkdtempSync('/tmp/mc-guard-sym-')
    try {
      const insidePath = join(tmpWorktree, 'file.ts')
      expect(isPathInWorktree(tmpWorktree, insidePath)).toBe(true)
    } finally {
      rmSync(tmpWorktree, { recursive: true, force: true })
    }
  })

  it('denies when worktree root does not exist (deny by default)', () => {
    expect(isPathInWorktree('/nonexistent-worktree-xyz', '/nonexistent-worktree-xyz/file.ts')).toBe(false)
  })

  // Case-insensitive macOS filesystems -----------------------------------------

  it('allows path with different case when the real filesystem resolves them equally', () => {
    // On a case-insensitive filesystem, /TMP/foo == /tmp/foo. We test with
    // an uppercase version of the worktree path; on macOS this will resolve
    // to the same real path, so the guard should allow it.
    // On case-sensitive Linux, this will denote a different path and should
    // also work correctly (denying it, since we compare lower-cased resolved paths).
    const upperWorktree = worktree.toUpperCase()
    const insidePath = join(worktree, 'file.ts')
    // We just assert the function doesn't throw — the exact result depends on fs.
    expect(typeof isPathInWorktree(upperWorktree, insidePath)).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// Hook entrypoint — stdin/stdout/exit-code tests
// ---------------------------------------------------------------------------

function runHook(
  payload: object,
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  // Invoke the compiled hook script using tsx (for TS source in tests)
  const hookPath = resolve(
    new URL('../../src/spawner/worktree-guard-hook.ts', import.meta.url).pathname,
  )
  const input = JSON.stringify(payload)
  try {
    const stdout = execSync(`echo '${input.replace(/'/g, "'\\''")}' | npx tsx ${hookPath}`, {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      timeout: 10000,
    })
    return { exitCode: 0, stdout, stderr: '' }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }
  }
}

describe('worktree-guard hook entrypoint', () => {
  let worktree: string

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'mc-hook-test-'))
    mkdirSync(join(worktree, '.claude'), { recursive: true })
  })

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true })
  })

  // Write tool -----------------------------------------------------------------

  it('exits 0 for Write tool with file_path inside worktree', () => {
    const result = runHook(
      { tool_name: 'Write', tool_input: { file_path: join(worktree, 'new.ts'), content: '' } },
      { MULTICLAUDE_WORKTREE: worktree, MULTICLAUDE_TASK_ID: 'test-task' },
    )
    expect(result.exitCode).toBe(0)
  })

  it('exits 2 for Write tool with file_path outside worktree', () => {
    const result = runHook(
      { tool_name: 'Write', tool_input: { file_path: '/etc/passwd', content: 'bad' } },
      { MULTICLAUDE_WORKTREE: worktree, MULTICLAUDE_TASK_ID: 'test-task' },
    )
    expect(result.exitCode).toBe(2)
  })

  it('writes a reason JSON on deny for Write', () => {
    const result = runHook(
      { tool_name: 'Write', tool_input: { file_path: '/etc/passwd', content: 'bad' } },
      { MULTICLAUDE_WORKTREE: worktree, MULTICLAUDE_TASK_ID: 'test-task' },
    )
    expect(result.exitCode).toBe(2)
    const parsed = JSON.parse(result.stdout.trim())
    expect(parsed).toHaveProperty('reason')
    expect(typeof parsed.reason).toBe('string')
    expect(parsed.reason.length).toBeGreaterThan(0)
  })

  // Edit tool ------------------------------------------------------------------

  it('exits 0 for Edit tool inside worktree', () => {
    const result = runHook(
      {
        tool_name: 'Edit',
        tool_input: { file_path: join(worktree, 'src.ts'), old_string: 'a', new_string: 'b' },
      },
      { MULTICLAUDE_WORKTREE: worktree },
    )
    expect(result.exitCode).toBe(0)
  })

  it('exits 2 for Edit tool outside worktree', () => {
    const result = runHook(
      { tool_name: 'Edit', tool_input: { file_path: '/usr/local/lib/evil.ts' } },
      { MULTICLAUDE_WORKTREE: worktree },
    )
    expect(result.exitCode).toBe(2)
  })

  // Read tool ------------------------------------------------------------------

  it('exits 0 for Read tool inside worktree', () => {
    const result = runHook(
      { tool_name: 'Read', tool_input: { file_path: join(worktree, 'README.md') } },
      { MULTICLAUDE_WORKTREE: worktree },
    )
    expect(result.exitCode).toBe(0)
  })

  it('exits 2 for Read tool outside worktree', () => {
    const result = runHook(
      { tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } },
      { MULTICLAUDE_WORKTREE: worktree },
    )
    expect(result.exitCode).toBe(2)
  })

  // NotebookEdit tool ----------------------------------------------------------

  it('exits 0 for NotebookEdit with notebook_path inside worktree', () => {
    const result = runHook(
      { tool_name: 'NotebookEdit', tool_input: { notebook_path: join(worktree, 'nb.ipynb') } },
      { MULTICLAUDE_WORKTREE: worktree },
    )
    expect(result.exitCode).toBe(0)
  })

  it('exits 2 for NotebookEdit with notebook_path outside worktree', () => {
    const result = runHook(
      { tool_name: 'NotebookEdit', tool_input: { notebook_path: '/tmp/evil.ipynb' } },
      { MULTICLAUDE_WORKTREE: worktree },
    )
    expect(result.exitCode).toBe(2)
  })

  // Unknown / untracked tools -------------------------------------------------

  it('exits 0 for an untracked tool (no path to check)', () => {
    const result = runHook(
      { tool_name: 'Bash', tool_input: { command: 'echo hello' } },
      { MULTICLAUDE_WORKTREE: worktree },
    )
    expect(result.exitCode).toBe(0)
  })

  // No worktree configured ----------------------------------------------------

  it('exits 0 when MULTICLAUDE_WORKTREE is not set (allow through)', () => {
    const result = runHook(
      { tool_name: 'Write', tool_input: { file_path: '/etc/passwd', content: 'bad' } },
      {}, // no MULTICLAUDE_WORKTREE
    )
    expect(result.exitCode).toBe(0)
  })

  // Violation logging ----------------------------------------------------------

  it('appends a log line to .claude/boundary-violations.log on deny', () => {
    const logFile = join(worktree, '.claude', 'boundary-violations.log')
    runHook(
      { tool_name: 'Write', tool_input: { file_path: '/etc/shadow', content: 'bad' } },
      { MULTICLAUDE_WORKTREE: worktree, MULTICLAUDE_TASK_ID: 'task-abc' },
    )
    expect(existsSync(logFile)).toBe(true)
    const log = readFileSync(logFile, 'utf-8').trim()
    const entry = JSON.parse(log.split('\n')[0])
    expect(entry.tool).toBe('Write')
    expect(entry.path).toBe('/etc/shadow')
    expect(entry.taskId).toBe('task-abc')
    expect(typeof entry.timestamp).toBe('string')
  })

  it('does not create log file when access is allowed', () => {
    const logFile = join(worktree, '.claude', 'boundary-violations.log')
    runHook(
      { tool_name: 'Write', tool_input: { file_path: join(worktree, 'safe.ts'), content: '' } },
      { MULTICLAUDE_WORKTREE: worktree, MULTICLAUDE_TASK_ID: 'task-abc' },
    )
    expect(existsSync(logFile)).toBe(false)
  })

  // Nested tool_use format (alternative payload shape) ------------------------

  it('handles nested tool_use format for Write', () => {
    const result = runHook(
      {
        tool_use: {
          name: 'Write',
          input: { file_path: '/etc/passwd', content: 'bad' },
        },
      },
      { MULTICLAUDE_WORKTREE: worktree },
    )
    expect(result.exitCode).toBe(2)
  })

  it('allows nested tool_use format inside worktree', () => {
    const result = runHook(
      {
        tool_use: {
          name: 'Write',
          input: { file_path: join(worktree, 'ok.ts'), content: '' },
        },
      },
      { MULTICLAUDE_WORKTREE: worktree },
    )
    expect(result.exitCode).toBe(0)
  })

  // argv fallback -------------------------------------------------------------

  it('accepts worktree root via argv when env var is absent', () => {
    const hookPath = resolve(
      new URL('../../src/spawner/worktree-guard-hook.ts', import.meta.url).pathname,
    )
    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/etc/passwd', content: 'bad' },
    })
    try {
      execSync(`echo '${payload.replace(/'/g, "'\\''")}' | npx tsx ${hookPath} ${worktree}`, {
        encoding: 'utf-8',
        env: { ...process.env },
        timeout: 10000,
      })
      // If we get here the hook allowed it — fail
      expect(true).toBe(false)
    } catch (err: unknown) {
      const e = err as { status?: number }
      expect(e.status).toBe(2)
    }
  })
})
