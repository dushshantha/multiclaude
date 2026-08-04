import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  classifyGhError,
  parseGitHubRemote,
  buildGhCreateArgs,
  type PrFailureReason,
} from '../src/git/pr.js'

describe('parseGitHubRemote', () => {
  it('parses HTTPS URL', () => {
    expect(parseGitHubRemote('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  it('parses HTTPS URL without .git suffix', () => {
    expect(parseGitHubRemote('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  it('parses SSH URL', () => {
    expect(parseGitHubRemote('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  it('parses SSH URL without .git suffix', () => {
    expect(parseGitHubRemote('git@github.com:owner/repo')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  it('returns null for non-GitHub HTTPS URL', () => {
    expect(parseGitHubRemote('https://gitlab.com/owner/repo.git')).toBeNull()
  })

  it('returns null for non-GitHub SSH URL', () => {
    expect(parseGitHubRemote('git@gitlab.com:owner/repo.git')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseGitHubRemote('')).toBeNull()
  })

  it('returns null for malformed URL', () => {
    expect(parseGitHubRemote('not-a-url')).toBeNull()
  })
})

describe('classifyGhError', () => {
  const cases: Array<[string, PrFailureReason]> = [
    ['gh: command not found', 'gh_not_installed'],
    ['ENOENT: gh not found', 'gh_not_installed'],
    ['spawn gh ENOENT', 'gh_not_installed'],
    ['gh auth login required', 'gh_not_authenticated'],
    ['not logged into any GitHub hosts', 'gh_not_authenticated'],
    ['To get started with GitHub CLI, please run: gh auth login', 'gh_not_authenticated'],
    ['No commits between main and feature/foo', 'no_commits'],
    ['error: No commits between', 'no_commits'],
    ['The head branch mc/run-abc has no new commits', 'no_commits'],
    ['error: pull request create failed: GraphQL: No commits', 'no_commits'],
    ['Remote origin not found', 'no_remote'],
    ['does not appear to be a git repository', 'no_remote'],
    ['fatal: repository has no remote', 'no_remote'],
    ['error: head branch not found on remote', 'head_not_pushed'],
    ['error: failed to push some refs', 'head_not_pushed'],
    ['branch not found on the remote', 'head_not_pushed'],
    ['some unexpected error message', 'pr_creation_failed'],
  ]

  for (const [stderr, expected] of cases) {
    it(`classifies "${stderr.slice(0, 50)}" as ${expected}`, () => {
      expect(classifyGhError(stderr)).toBe(expected)
    })
  }
})

describe('buildGhCreateArgs', () => {
  it('passes title and body as separate argv entries, never concatenated', () => {
    const args = buildGhCreateArgs({
      head: 'feature/my-branch',
      base: 'main',
      title: 'My PR title',
      body: 'Line 1\nLine 2',
    })

    // Verify title is a separate argument after --title flag
    const titleIdx = args.indexOf('--title')
    expect(titleIdx).toBeGreaterThan(-1)
    expect(args[titleIdx + 1]).toBe('My PR title')

    // Verify body is a separate argument after --body flag
    const bodyIdx = args.indexOf('--body')
    expect(bodyIdx).toBeGreaterThan(-1)
    expect(args[bodyIdx + 1]).toBe('Line 1\nLine 2')

    // Critical: no single argv entry should merge a flag with its value
    // (e.g. '--title My PR title' as one string is the unsafe concatenated form)
    expect(args).not.toContain('--title My PR title')
    expect(args).not.toContain('--body Line 1\nLine 2')
    // The actual check: each value is a standalone entry in the array
    expect(args).toContain('My PR title')
    expect(args).toContain('Line 1\nLine 2')
  })

  it('includes --head and --base flags', () => {
    const args = buildGhCreateArgs({
      head: 'mc/run-abc',
      base: 'main',
      title: 'Test',
      body: 'Body',
    })
    expect(args).toContain('--head')
    expect(args).toContain('mc/run-abc')
    expect(args).toContain('--base')
    expect(args).toContain('main')
  })

  it('handles title with special shell characters safely', () => {
    const title = 'Fix: handle `backticks` and "quotes" and $variables'
    const body = 'Body with $(command) injection attempt; rm -rf /'

    const args = buildGhCreateArgs({ head: 'h', base: 'b', title, body })

    const titleIdx = args.indexOf('--title')
    expect(args[titleIdx + 1]).toBe(title)

    const bodyIdx = args.indexOf('--body')
    expect(args[bodyIdx + 1]).toBe(body)
  })

  it('handles multiline body without shell injection', () => {
    const body = 'Line 1\n## Section\n- item 1\n- item 2\n\nTrailing newline\n'
    const args = buildGhCreateArgs({ head: 'h', base: 'b', title: 'T', body })

    const bodyIdx = args.indexOf('--body')
    expect(args[bodyIdx + 1]).toBe(body)
    // Entire body is one argv entry
    expect(args.filter(a => a === body).length).toBe(1)
  })

  it('first element is "pr" and second is "create"', () => {
    const args = buildGhCreateArgs({ head: 'h', base: 'b', title: 'T', body: 'B' })
    expect(args[0]).toBe('pr')
    expect(args[1]).toBe('create')
  })
})
