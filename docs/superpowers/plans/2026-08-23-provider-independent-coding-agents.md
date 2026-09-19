# Provider-Independent Coding Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow MultiClaude projects and individual tasks to run with Claude Code, Codex, or Cursor while preserving worktree isolation, MCP completion reporting, and legacy configuration.

**Architecture:** Split coding-agent behavior from execution transport. Provider adapters prepare safe executable/argument/environment descriptions and normalize output; process, PTY, and tmux transports launch those descriptions. Resolve and persist provider selection at run, task, and agent-attempt boundaries so a later release can add quota failover without losing history.

**Tech Stack:** TypeScript 5.9, Node.js child processes, node-pty, tmux, better-sqlite3, MCP Streamable HTTP, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-provider-independent-coding-agents-design.md`

## Global Constraints

- Default behavior remains Claude plus process transport.
- Supported providers are exactly `claude`, `codex`, and `cursor`.
- Supported transports are exactly `process`, `pty`, and `tmux`.
- Do not hard-code a default Codex model; omit `--model` when none is configured.
- MCP `report_done` and `report_blocked` remain authoritative over process exit status.
- Never persist authentication secrets or complete environment dumps.
- Never grant Codex unrestricted filesystem access as an isolation fallback.
- Legacy `workerRuntime` values continue to work and are never rewritten automatically.
- Cross-provider automatic failover is outside this implementation.

---

### Task 1: Provider-aware configuration and legacy translation

**Files:**
- Modify: `src/config.ts`
- Modify: `src/cli.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/init.test.ts`

**Interfaces:**
- Produces: `ProviderId`, `TransportId`, `ProviderOptions`, and expanded `MultiClaudeConfig`.
- Produces: `resolveWorkerSelection(config, overrides): ResolvedWorkerSelection`.
- Consumed by: all later routing, provider, and transport tasks.

- [ ] **Step 1: Add failing configuration tests**

Add tests that cover new fields, defaults, CLI-style overrides, invalid values, and all legacy translations:

```ts
expect(resolveWorkerSelection({}, {})).toEqual({ provider: 'claude', transport: 'process' })
expect(resolveWorkerSelection({ workerRuntime: 'cursor' }, {})).toEqual({ provider: 'cursor', transport: 'pty', legacy: true })
expect(resolveWorkerSelection({ workerRuntime: 'tmux' }, {})).toEqual({ provider: 'claude', transport: 'tmux', legacy: true })
expect(resolveWorkerSelection(
  { workerProvider: 'codex', workerTransport: 'process' },
  { provider: 'claude', transport: 'tmux' },
)).toEqual({ provider: 'claude', transport: 'tmux' })
expect(() => parseConfig({ workerProvider: 'unknown' })).toThrow(/workerProvider/)
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run tests/config.test.ts tests/init.test.ts`

Expected: FAIL because the new types and resolution functions do not exist.

- [ ] **Step 3: Implement configuration types and resolution**

Define these public shapes in `src/config.ts`:

```ts
export type ProviderId = 'claude' | 'codex' | 'cursor'
export type TransportId = 'process' | 'pty' | 'tmux'

export interface ProviderOptions {
  model?: string | null
  profile?: string | null
}

export interface MultiClaudeConfig {
  workerProvider?: ProviderId
  workerTransport?: TransportId
  providerOptions?: Partial<Record<ProviderId, ProviderOptions>>
  workerRuntime?: 'claude' | 'cursor' | 'tmux'
  stuckWarningMinutes?: number
  stuckTimeoutMinutes?: number
}

export interface ResolvedWorkerSelection {
  provider: ProviderId
  transport: TransportId
  legacy?: true
}
```

Implement strict parsing and this precedence: CLI override, new config, legacy translation, Claude/process default. Update `src/cli.ts` to accept `--worker-provider=` and `--worker-transport=`, reject invalid values, and emit one deprecation warning when `legacy === true`.

- [ ] **Step 4: Run focused tests and build**

Run: `npx vitest run tests/config.test.ts tests/init.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit configuration support**

```bash
git add src/config.ts src/cli.ts tests/config.test.ts tests/init.test.ts
git commit -m "feat: add provider and transport configuration"
```

### Task 2: Provider contracts and canonical worker instructions

**Files:**
- Create: `src/providers/types.ts`
- Create: `src/providers/instructions.ts`
- Create: `src/providers/index.ts`
- Create: `src/providers/claude.ts`
- Create: `src/providers/cursor.ts`
- Modify: `src/spawner/index.ts`
- Modify: `src/spawner/cursor.ts`
- Create: `tests/providers/contract.test.ts`
- Create: `tests/providers/instructions.test.ts`
- Create: `tests/providers/claude.test.ts`
- Create: `tests/providers/cursor.test.ts`

**Interfaces:**
- Consumes: `ProviderId` from `src/config.ts`.
- Produces: `CodingAgentProvider`, `PreparedWorker`, `ProviderEvent`, `AgentFailureKind`, and `buildWorkerInstructions()`.
- Produces: `createProvider(id): CodingAgentProvider` for Task 4 and later.

- [ ] **Step 1: Write contract and instruction tests**

Test that both existing providers return argument arrays without shell command strings, use identical canonical workflow text, and sanitize nested-session variables:

```ts
const text = buildWorkerInstructions({ agentId: 'a1', taskTitle: 'Add auth', taskDescription: 'Use sessions' })
expect(text).toContain('get_my_task')
expect(text).toContain('report_progress')
expect(text).toContain('report_done')
expect(text).toContain('report_blocked')

for (const id of ['claude', 'cursor'] as const) {
  const prepared = await createProvider(id).prepare(fixtureContext())
  expect(prepared.command).toMatch(/^(claude|cursor)$/)
  expect(prepared.args).toBeInstanceOf(Array)
  expect(prepared.cwd).toBe(fixtureContext().worktreePath)
}
```

- [ ] **Step 2: Run provider tests and confirm failure**

Run: `npx vitest run tests/providers`

Expected: FAIL because `src/providers` does not exist.

- [ ] **Step 3: Define provider contracts**

Create exact core types:

```ts
export type AgentFailureKind =
  | 'not_installed'
  | 'not_authenticated'
  | 'quota_exhausted'
  | 'permission_denied'
  | 'invalid_model'
  | 'mcp_unavailable'
  | 'process_crashed'
  | 'task_failed'

export interface PreparedWorker {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  logPath: string
  requiresPty: boolean
  cleanup(): void
}

export interface CodingAgentProvider {
  readonly id: ProviderId
  preflight(context: ProviderContext): Promise<ProviderPreflightResult>
  prepare(context: WorkerLaunchContext): Promise<PreparedWorker>
  parseEvent(line: string): ProviderEvent | undefined
  classifyFailure(result: ProcessResult): AgentFailure
}
```

Include `ProviderContext`, `WorkerLaunchContext`, `ProviderPreflightResult`, `ProviderEvent`, `ProcessResult`, and `AgentFailure` in the same file with only serializable fields except for `PreparedWorker.cleanup`.

- [ ] **Step 4: Extract Claude and Cursor preparation behind adapters**

Move prompt construction to `buildWorkerInstructions()`. Make Claude and Cursor adapters reuse existing argument, MCP, settings, logging, and environment helpers. Preserve current behavior byte-for-byte where feasible. `createProvider()` must use an exhaustive switch on `ProviderId`.

- [ ] **Step 5: Run provider tests and existing parity tests**

Run: `npx vitest run tests/providers tests/spawner/index.test.ts tests/spawner/cursor.test.ts tests/spawner/backend.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the provider seam**

```bash
git add src/providers src/spawner/index.ts src/spawner/cursor.ts tests/providers tests/spawner
git commit -m "refactor: introduce coding agent provider contracts"
```

### Task 3: Persist provider selection on runs, tasks, and attempts

**Files:**
- Modify: `src/server/state/db.ts`
- Modify: `src/server/state/runs.ts`
- Modify: `src/server/state/tasks.ts`
- Modify: `src/server/state/agents.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/tools/orchestrator.ts`
- Modify: `src/server/tools/worker.ts`
- Modify: `tests/state/db.test.ts`
- Modify: `tests/state/runs.test.ts`
- Modify: `tests/state/tasks.test.ts`
- Modify: `tests/state/agents.test.ts`
- Modify: `tests/tools/orchestrator.test.ts`
- Modify: `tests/tools/worker.test.ts`

**Interfaces:**
- Consumes: `ProviderId`, `TransportId`, and `AgentFailureKind`.
- Produces: resolved `provider` and `transport` on run rows; optional requested `provider` on tasks; resolved provider/model/effort and `failure_kind` on agent attempts.
- Produces: `resolveTaskProvider(task, run): ProviderId`.

- [ ] **Step 1: Write failing migration and routing tests**

Cover a pre-feature database, new database defaults, task override, run snapshot, and attempt history:

```ts
expect(resolveTaskProvider({ provider: 'codex' }, { provider: 'claude' })).toBe('codex')
expect(resolveTaskProvider({ provider: null }, { provider: 'codex' })).toBe('codex')

const columns = db.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>
expect(columns.map(c => c.name)).toEqual(expect.arrayContaining(['provider', 'model', 'effort', 'failure_kind']))
```

Also assert that `plan_dag` accepts only the three provider IDs and that `create_run` snapshots provider and transport.

- [ ] **Step 2: Run state and tool tests to confirm failure**

Run: `npx vitest run tests/state tests/tools/orchestrator.test.ts tests/tools/worker.test.ts`

Expected: FAIL on missing columns and schema fields.

- [ ] **Step 3: Add idempotent migrations and row types**

Add nullable `tasks.provider`; non-null `runs.provider DEFAULT 'claude'`; non-null `runs.transport DEFAULT 'process'`; non-null `agents.provider DEFAULT 'claude'`; nullable `agents.model`; nullable `agents.effort`; and nullable `agents.failure_kind`. Use the existing guarded `ALTER TABLE` pattern so old databases upgrade in place.

- [ ] **Step 4: Extend MCP schemas and routing**

Add provider fields to `create_run` and `plan_dag`. Persist the run snapshot at creation, task override at planning, and resolved selection when an attempt is created. Return these fields from status APIs. Change cost reporting to use the attempt's resolved provider/model rather than assuming the task's Claude tier.

- [ ] **Step 5: Run focused tests and database compatibility tests**

Run: `npx vitest run tests/state tests/tools/orchestrator.test.ts tests/tools/worker.test.ts tests/server.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit persistence and routing**

```bash
git add src/server tests/state tests/tools tests/server.test.ts
git commit -m "feat: persist provider routing per worker attempt"
```

### Task 4: Separate process, PTY, and tmux transports

**Files:**
- Create: `src/transports/types.ts`
- Create: `src/transports/process.ts`
- Create: `src/transports/pty.ts`
- Create: `src/transports/tmux.ts`
- Modify: `src/spawner/backend.ts`
- Modify: `src/spawner/tmux.ts`
- Modify: `src/cli.ts`
- Create: `tests/transports/process.test.ts`
- Create: `tests/transports/pty.test.ts`
- Create: `tests/transports/tmux.test.ts`
- Modify: `tests/spawner/backend.test.ts`
- Modify: `tests/spawner/tmux.test.ts`

**Interfaces:**
- Consumes: `PreparedWorker` from `src/providers/types.ts` and `TransportId` from `src/config.ts`.
- Produces: `ExecutionTransport` and `createTransport(id): ExecutionTransport`.
- Produces: `validateProviderTransport(provider, transport): void`.

- [ ] **Step 1: Write failing transport contract tests**

Test the compatibility matrix and transport ownership:

```ts
expect(() => validateProviderTransport('cursor', 'process')).toThrow(/requires pty/i)
expect(() => validateProviderTransport('codex', 'tmux')).not.toThrow()
expect(createTransport('process').id).toBe('process')
expect(createTransport('pty').id).toBe('pty')
expect(createTransport('tmux').id).toBe('tmux')
```

Use fake prepared workers to assert command, args, cwd, environment, logging, exit, error, and cleanup forwarding.

- [ ] **Step 2: Run transport tests and confirm failure**

Run: `npx vitest run tests/transports tests/spawner/backend.test.ts`

Expected: FAIL because the transport modules do not exist.

- [ ] **Step 3: Implement transport factories and compatibility validation**

Make process transport use `spawn(prepared.command, prepared.args, ...)`, PTY transport use `node-pty`, and tmux transport serialize a safe launch script from the prepared command and argument array. Reuse the existing tmux quoting and lifecycle functions. Ensure every exit path invokes `prepared.cleanup()` exactly once.

- [ ] **Step 4: Route spawning through provider then transport**

Replace runtime selection with:

```ts
const provider = createProvider(resolved.provider)
const prepared = await provider.prepare(context)
validateProviderTransport(provider.id, resolved.transport)
const handle = createTransport(resolved.transport).launch(prepared)
```

Perform provider preflight and compatibility validation before creating a worktree. Do not count a preflight failure as a retry or coding attempt.

- [ ] **Step 5: Run transport, spawner, retry, and recovery suites**

Run: `npx vitest run tests/transports tests/spawner tests/tools/recover-task.test.ts tests/tools/window-reaping.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit transport separation**

```bash
git add src/transports src/spawner src/cli.ts tests/transports tests/spawner tests/tools
git commit -m "refactor: separate agent providers from transports"
```

### Task 5: Codex provider, structured events, and failure normalization

**Files:**
- Create: `src/providers/codex.ts`
- Create: `src/providers/failures.ts`
- Create: `tests/fixtures/fake-codex.mjs`
- Create: `tests/providers/codex.test.ts`
- Create: `tests/providers/failures.test.ts`
- Create: `tests/integration/codex-worker.test.ts`
- Modify: `src/providers/index.ts`
- Modify: `src/server/tools/orchestrator.ts`

**Interfaces:**
- Consumes: provider contracts, canonical instructions, worker MCP URL, and worktree isolation metadata.
- Produces: `CodexProvider` and `classifyProviderFailure(provider, result)`.
- Produces normalized Codex progress, usage, final-message, and failure events.

- [ ] **Step 1: Add fake Codex fixture and failing adapter tests**

The fixture accepts Codex-style arguments and emits JSONL modes selected by `FAKE_CODEX_SCENARIO`: `complete`, `blocked`, `quota`, `auth`, `invalid-model`, `malformed`, `crash`, and `done-then-crash`.

Assert exact core arguments:

```ts
expect(args).toEqual(expect.arrayContaining([
  'exec', '--cd', worktreePath,
  '--sandbox', 'workspace-write',
  '--ask-for-approval', 'never',
  '--json',
]))
expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
expect(args).not.toContain('--model')
```

Add a second assertion that configured model/profile values emit `--model <value>` and `--profile <value>`.

- [ ] **Step 2: Run Codex tests and confirm failure**

Run: `npx vitest run tests/providers/codex.test.ts tests/providers/failures.test.ts tests/integration/codex-worker.test.ts`

Expected: FAIL because the Codex provider is not registered.

- [ ] **Step 3: Implement Codex preflight and preparation**

Preflight checks executable discovery, `codex --version`, authentication with `codex login status`, MCP configuration support, profile/model syntax, and transport compatibility. Return structured failures rather than throwing raw child-process errors. Treat a missing `codex login status` subcommand as a version-compatibility error rather than starting a paid coding turn to probe authentication.

Configure `multiclaude-worker` per invocation with the argument-array entries `-c` and `mcp_servers.multiclaude-worker.url="http://localhost:<port>/worker"`. Do not mutate the user's global MCP configuration. Resolve the linked worktree Git directory with the existing `readWorktreeGitDir()` helper and pass only that exact directory through `--add-dir`; never pass the parent repository or its complete `.git` directory.

- [ ] **Step 4: Parse JSONL and classify failures**

Prefer structured JSON fields. Sanitize stored messages. Map only verified quota/session-limit signals to `quota_exhausted`; map missing auth to `not_authenticated`; missing executable to `not_installed`; sandbox denials to `permission_denied`; model rejection to `invalid_model`; MCP connection failures to `mcp_unavailable`; abnormal unknown exits to `process_crashed`; and explicit worker failure to `task_failed`.

- [ ] **Step 5: Test authoritative completion reconciliation**

In the fake integration test, make `done-then-crash` mark the task done through MCP before exiting non-zero. Assert the exit watcher leaves the task done. Also assert a zero exit without `report_done` does not mark the task complete.

- [ ] **Step 6: Run Codex and affected integration suites**

Run: `npx vitest run tests/providers tests/integration/codex-worker.test.ts tests/integration/worktree-lifecycle.test.ts tests/spawner/agent-process-verification.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Codex worker support**

```bash
git add src/providers src/server/tools/orchestrator.ts tests/providers tests/fixtures tests/integration
git commit -m "feat: add Codex worker provider"
```

### Task 6: Codex project initialization and orchestrator setup

**Files:**
- Modify: `src/init.ts`
- Modify: `src/cli.ts`
- Create: `prompts/orchestrator-codex.md`
- Modify: `tests/init.test.ts`
- Modify: `tests/init-preflight.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: configuration types and `multiclaude-coord` MCP URL/tool names.
- Produces: `multiclaude init --codex` with idempotent `AGENTS.md`, config, and project MCP setup.

- [ ] **Step 1: Write failing Codex initialization tests**

Run init twice in a temporary project and assert:

```ts
expect(readConfig(projectDir)?.workerProvider).toBe('codex')
expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toContain('MultiClaude Orchestrator')
expect(countOccurrences(agentsMd, '<!-- multiclaude:start -->')).toBe(1)
expect(agentsMd).toContain('User-owned AGENTS instructions')
expect(codexConfig).toContain('model_reasoning_effort = "high"')
```

Also assert `--codex` and `--cursor`/`--claude` are mutually exclusive.

- [ ] **Step 2: Run init tests and confirm failure**

Run: `npx vitest run tests/init.test.ts tests/init-preflight.test.ts`

Expected: FAIL because `--codex` and Codex initialization are absent.

- [ ] **Step 3: Implement idempotent Codex initialization**

Write a marked MultiClaude section into `AGENTS.md`, merge the `multiclaude-coord` entry into `.codex/config.toml` without replacing unrelated TOML keys, and write `workerProvider: "codex"` plus `workerTransport: "process"`. The tests seed `AGENTS.md` with `User-owned AGENTS instructions` and `.codex/config.toml` with `model_reasoning_effort = "high"` before initialization. Keep existing Claude and Cursor initialization behavior. Print the exact next command `codex` for the orchestrator.

- [ ] **Step 4: Add Codex setup and migration documentation**

Document prerequisites, `multiclaude init --codex`, provider/transport flags, task overrides, supported combinations, legacy translation, authentication/preflight errors, and the absence of automatic failover in this release.

- [ ] **Step 5: Run init tests and build**

Run: `npx vitest run tests/init.test.ts tests/init-preflight.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit Codex initialization**

```bash
git add src/init.ts src/cli.ts prompts/orchestrator-codex.md tests/init.test.ts tests/init-preflight.test.ts README.md
git commit -m "feat: initialize Codex orchestrators"
```

### Task 7: Provider-aware cost accounting and observability

**Files:**
- Modify: `src/server/cost.ts`
- Modify: `src/tui/index.tsx`
- Modify: `src/web/public/tasks.html`
- Modify: `src/web/public/run.html`
- Modify: `src/web/server.ts`
- Modify: `tests/tools/cost.test.ts`
- Modify: `tests/server.test.ts`
- Create: `tests/web/provider-display.test.ts`

**Interfaces:**
- Consumes: persisted run/task/attempt provider, model, transport, failure kind, logs, and usage.
- Produces: `calculateCostForProvider(provider, model, inputTokens, outputTokens): number | null`.
- Produces provider-aware task and attempt API responses and UI badges.

- [ ] **Step 1: Write failing cost and API tests**

```ts
expect(calculateCostForProvider('codex', 'unknown', 1000, 1000)).toBeNull()
expect(calculateCostForProvider('cursor', null, 1000, 1000)).toBeNull()
expect(calculateCostForProvider('claude', 'sonnet', 1_000_000, 0)).toBeGreaterThan(0)
expect(taskJson).toMatchObject({ provider: 'codex', transport: 'process', model: null })
```

Add rendered-output assertions for provider, `configured default`, transport, and normalized failure kind.

- [ ] **Step 2: Run cost, server, and web tests to confirm failure**

Run: `npx vitest run tests/tools/cost.test.ts tests/server.test.ts tests/web/provider-display.test.ts`

Expected: FAIL on Claude fallback pricing and missing UI fields.

- [ ] **Step 3: Make pricing provider-aware**

Retain current Claude pricing lookup only when `provider === 'claude'`. Return `null` for an unpriced provider/model. Update database/reporting types so unavailable cost remains null and displays as `—`, never `$0.00` or a Claude estimate.

- [ ] **Step 4: Add provider and transport to TUI and web views**

Display requested/resolved provider where relevant, resolved model or `configured default`, transport, failure kind, and provider log path. Keep existing task status and DAG behavior unchanged. Escape all web-rendered values through the existing HTML escaping helper.

- [ ] **Step 5: Run focused tests and build**

Run: `npx vitest run tests/tools/cost.test.ts tests/server.test.ts tests/web/provider-display.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit observability**

```bash
git add src/server src/tui src/web tests/tools/cost.test.ts tests/server.test.ts tests/web
git commit -m "feat: show provider details and accurate costs"
```

### Task 8: Isolation proof, full regression suite, and release documentation

**Files:**
- Create: `tests/integration/codex-isolation.test.ts`
- Create: `tests/integration/provider-routing.e2e.test.ts`
- Create: `tests/integration/real-codex.smoke.test.ts`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: the complete provider, transport, persistence, initialization, and UI implementation.
- Produces: release gate proving explicit provider selection is safe and backward-compatible.

- [ ] **Step 1: Add isolation and routing end-to-end tests**

Use fake provider executables for normal CI. Assert that Codex can edit and commit in its linked worktree, cannot write to the parent checkout via direct path/traversal/symlink, and receives only the specific worktree Git metadata grant. Assert project default, run snapshot, and task override routing across server restart.

- [ ] **Step 2: Add opt-in real Codex smoke test**

Guard the test exactly:

```ts
const runRealCodex = process.env.MULTICLAUDE_CODEX_E2E === '1'
describe.skipIf(!runRealCodex)('real Codex worker', () => {
  // create a temporary repository, run one minimal worker, verify MCP completion and commit isolation
})
```

Add `test:codex:e2e` as `MULTICLAUDE_CODEX_E2E=1 vitest run tests/integration/real-codex.smoke.test.ts`. Do not include it in the default `npm test` command.

- [ ] **Step 3: Run focused end-to-end tests**

Run: `npx vitest run tests/integration/codex-isolation.test.ts tests/integration/provider-routing.e2e.test.ts`

Expected: PASS without provider authentication or network access.

- [ ] **Step 4: Complete release documentation**

Ensure README examples cover Claude, Codex, Cursor, process/tmux selection, per-task provider overrides, legacy configuration, failure messages, security boundaries, and the future-but-not-yet-implemented quota failover policy. Update any statements that call the system Claude-only or describe tmux as inherently Claude-specific.

- [ ] **Step 5: Run complete verification**

Run: `env -u PAGER -u GIT_PAGER npm test`

Expected: all test files and tests PASS with zero unhandled errors.

Run: `npm run build`

Expected: PASS.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 6: Optionally run the authenticated smoke test**

Run only when the developer explicitly opts in and Codex is authenticated:

`npm run test:codex:e2e`

Expected: PASS; if skipped, record that the fake-provider isolation suite passed and the authenticated smoke test was not run.

- [ ] **Step 7: Commit the release gate**

```bash
git add tests/integration README.md package.json
git commit -m "test: verify provider-independent worker routing"
```
