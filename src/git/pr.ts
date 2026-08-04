import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { simpleGit } from 'simple-git'

const execFile = promisify(execFileCb)

export type PrFailureReason =
  | 'no_remote'
  | 'not_github'
  | 'gh_not_installed'
  | 'gh_not_authenticated'
  | 'head_not_pushed'
  | 'no_commits'
  | 'pr_creation_failed'

export type PrResult =
  | { ok: true; url: string; number: number; alreadyExisted: boolean }
  | { ok: false; reason: PrFailureReason; detail: string }

export interface PrOptions {
  repoPath: string
  head: string
  base: string
  title: string
  body: string
}

/** Parse owner/repo from a GitHub remote URL (HTTPS or SSH). Returns null for non-GitHub remotes. */
export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  if (!remoteUrl) return null

  // HTTPS: https://github.com/owner/repo[.git]
  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] }

  // SSH: git@github.com:owner/repo[.git]
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] }

  return null
}

/** Classify a gh CLI or API error string into a stable failure reason slug. */
export function classifyGhError(stderr: string): PrFailureReason {
  const s = stderr.toLowerCase()

  if (/enoent|gh: command not found|spawn gh enoent/.test(s)) return 'gh_not_installed'
  if (/gh auth login|not logged into|to get started with github cli/.test(s)) return 'gh_not_authenticated'
  if (/no commits between|has no new commits|graphql: no commits/.test(s)) return 'no_commits'
  if (/no remote|remote.*not found|does not appear to be a git repository|repository has no remote/.test(s)) return 'no_remote'
  if (/head branch.*not found on remote|failed to push some refs|branch not found on the remote/.test(s)) return 'head_not_pushed'

  return 'pr_creation_failed'
}

/** Build the argv array passed to `gh` (after the `gh` binary itself). */
export function buildGhCreateArgs(opts: {
  head: string
  base: string
  title: string
  body: string
}): string[] {
  return [
    'pr', 'create',
    '--head', opts.head,
    '--base', opts.base,
    '--title', opts.title,
    '--body', opts.body,
  ]
}

async function getOriginRemote(repoPath: string): Promise<string | null> {
  try {
    const git = simpleGit(repoPath)
    const remotes = await git.getRemotes(true)
    const origin = remotes.find(r => r.name === 'origin')
    return origin?.refs?.fetch ?? null
  } catch {
    return null
  }
}

/** Check if gh CLI is available. */
export async function isGhAvailable(): Promise<boolean> {
  try {
    await execFile('gh', ['--version'])
    return true
  } catch {
    return false
  }
}

/** Check if gh CLI is authenticated. */
export async function isGhAuthenticated(repoPath: string): Promise<boolean> {
  try {
    await execFile('gh', ['auth', 'status'], { cwd: repoPath })
    return true
  } catch {
    return false
  }
}

/** Check for an existing open PR on the given head branch via gh CLI. */
async function findExistingPrViaGh(
  repoPath: string,
  head: string,
): Promise<{ url: string; number: number } | null> {
  try {
    const { stdout } = await execFile(
      'gh',
      ['pr', 'list', '--head', head, '--state', 'open', '--json', 'url,number'],
      { cwd: repoPath },
    )
    const parsed = JSON.parse(stdout.trim()) as Array<{ url: string; number: number }>
    if (parsed.length > 0) return { url: parsed[0].url, number: parsed[0].number }
  } catch {
    // gh not available or failed — fall through
  }
  return null
}

/** Check for an existing open PR via GitHub REST API. */
async function findExistingPrViaApi(
  owner: string,
  repo: string,
  head: string,
  token: string,
): Promise<{ url: string; number: number } | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${head}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )
    if (!resp.ok) return null
    const prs = await resp.json() as Array<{ html_url: string; number: number }>
    if (prs.length > 0) return { url: prs[0].html_url, number: prs[0].number }
  } catch {
    // network error
  }
  return null
}

/** Create a PR via gh CLI. Returns PrResult. */
async function createPrViaGh(opts: PrOptions): Promise<PrResult> {
  const args = buildGhCreateArgs({
    head: opts.head,
    base: opts.base,
    title: opts.title,
    body: opts.body,
  })

  try {
    const { stdout, stderr } = await execFile('gh', args, { cwd: opts.repoPath })
    const combined = stdout + stderr
    const urlMatch = combined.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)
    const url = urlMatch ? urlMatch[0] : stdout.trim()
    const numMatch = url.match(/\/pull\/(\d+)$/)
    const number = numMatch ? parseInt(numMatch[1], 10) : 0
    return { ok: true, url, number, alreadyExisted: false }
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const stderr = (e.stderr ?? '') + (e.stdout ?? '') + (e.message ?? '')
    const reason = classifyGhError(stderr)
    return { ok: false, reason, detail: actionableDetail(reason, stderr) }
  }
}

/** Create a PR via GitHub REST API using a token. Returns PrResult. */
async function createPrViaApi(
  opts: PrOptions,
  owner: string,
  repo: string,
  token: string,
): Promise<PrResult> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: opts.title,
        body: opts.body,
        head: opts.head,
        base: opts.base,
      }),
    })

    if (resp.ok) {
      const pr = await resp.json() as { html_url: string; number: number }
      return { ok: true, url: pr.html_url, number: pr.number, alreadyExisted: false }
    }

    const errBody = await resp.json().catch(() => ({})) as { message?: string; errors?: unknown[] }
    const message = errBody.message ?? `HTTP ${resp.status}`
    const reason = classifyApiError(resp.status, message)
    return { ok: false, reason, detail: actionableDetail(reason, message) }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'pr_creation_failed', detail: `GitHub API request failed: ${message}` }
  }
}

function classifyApiError(status: number, message: string): PrFailureReason {
  const m = message.toLowerCase()
  if (status === 401 || status === 403) return 'gh_not_authenticated'
  if (/no commits between/.test(m)) return 'no_commits'
  if (/head.*not found|not found.*head/.test(m)) return 'head_not_pushed'
  return 'pr_creation_failed'
}

function actionableDetail(reason: PrFailureReason, rawError: string): string {
  switch (reason) {
    case 'gh_not_installed':
      return 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/ or set GITHUB_TOKEN to use the API fallback.'
    case 'gh_not_authenticated':
      return 'GitHub CLI is not authenticated. Run: gh auth login'
    case 'head_not_pushed':
      return `The head branch has not been pushed to the remote. Push it first, then retry. (${rawError.trim()})`
    case 'no_commits':
      return `No commits between the base and head branches — nothing to merge. (${rawError.trim()})`
    case 'no_remote':
      return 'No git remote named "origin" found. Add a remote with: git remote add origin <url>'
    case 'not_github':
      return 'The "origin" remote does not point to GitHub. This tool only supports GitHub repositories.'
    case 'pr_creation_failed':
      return `Pull request creation failed: ${rawError.trim()}`
  }
}

/**
 * Create a GitHub pull request from the server process.
 *
 * Strategy (in order):
 * 1. Idempotency check — return existing open PR if found.
 * 2. gh CLI if available and authenticated.
 * 3. GitHub REST API if GITHUB_TOKEN or GH_TOKEN is set.
 */
export async function createPullRequest(opts: PrOptions): Promise<PrResult> {
  // Step 0: Resolve the remote URL to validate it's GitHub
  const remoteUrl = await getOriginRemote(opts.repoPath)
  if (!remoteUrl) {
    return {
      ok: false,
      reason: 'no_remote',
      detail: actionableDetail('no_remote', ''),
    }
  }

  const parsed = parseGitHubRemote(remoteUrl)
  if (!parsed) {
    return {
      ok: false,
      reason: 'not_github',
      detail: actionableDetail('not_github', remoteUrl),
    }
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN

  // Step 1: Idempotency — check for existing open PR
  const ghAvailable = await isGhAvailable()
  if (ghAvailable) {
    const existing = await findExistingPrViaGh(opts.repoPath, opts.head)
    if (existing) return { ok: true, ...existing, alreadyExisted: true }
  } else if (token) {
    const existing = await findExistingPrViaApi(parsed.owner, parsed.repo, opts.head, token)
    if (existing) return { ok: true, ...existing, alreadyExisted: true }
  }

  // Step 2: gh CLI path
  if (ghAvailable) {
    const authenticated = await isGhAuthenticated(opts.repoPath)
    if (authenticated) {
      return createPrViaGh(opts)
    }
    // gh available but not authenticated — fall through to API if token exists
    if (!token) {
      return {
        ok: false,
        reason: 'gh_not_authenticated',
        detail: actionableDetail('gh_not_authenticated', ''),
      }
    }
  }

  // Step 3: API fallback when gh is missing/unauthenticated but token is set
  if (token) {
    return createPrViaApi(opts, parsed.owner, parsed.repo, token)
  }

  // gh not installed and no token
  return {
    ok: false,
    reason: 'gh_not_installed',
    detail: actionableDetail('gh_not_installed', ''),
  }
}
