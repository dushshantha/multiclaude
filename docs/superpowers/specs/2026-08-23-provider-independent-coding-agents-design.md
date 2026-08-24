# Provider-Independent Coding Agents

Date: 2026-08-23
Status: Draft for user review

## Summary

MultiClaude currently treats Claude Code as its primary worker agent, with partial Cursor support and tmux as a Claude-specific runtime. When a user's Claude session allowance is exhausted, all queued work fails until the allowance resets.

This change makes coding-agent selection explicit and provider-independent. The first release supports Claude Code, Codex, and Cursor through a common provider interface. Users select a project default and may override it per task. Automatic quota failover is deliberately deferred until explicit provider routing is proven reliable, but the data model and failure taxonomy are designed to support it.

## Goals

- Let users run workers with Claude Code, Codex, or Cursor.
- Allow a project default provider and a per-task provider override.
- Let Codex orchestrators initialize a project whose workers default to Codex.
- Separate the coding-agent provider from the process transport.
- Preserve the existing worktree isolation and worker MCP protocol.
- Record the provider and model used by every worker attempt.
- Normalize provider failures so quota-aware failover can be added safely later.
- Keep existing `.multiclaude.json` configurations working.

## Non-goals

- Automatically choose providers based on task complexity.
- Automatically fail over between providers in the first release.
- Support arbitrary user-supplied agent command templates.
- Normalize provider-specific models into a universal quality tier.
- Change task decomposition, DAG scheduling, merging, or PR creation.

## Architecture

Provider choice and execution transport become independent concepts:

```text
Task routing policy
        |
        v
CodingAgentProvider: claude | codex | cursor
        |
        v
ExecutionTransport: process | pty | tmux
        |
        v
Isolated worktree + worker MCP protocol
```

The existing `RuntimeBackend` abstraction conflates agent behavior and process hosting. It will be replaced or evolved into two contracts.

### Coding agent provider

```ts
type ProviderId = 'claude' | 'codex' | 'cursor'

interface CodingAgentProvider {
  readonly id: ProviderId
  preflight(context: ProviderContext): Promise<ProviderPreflightResult>
  prepare(context: WorkerLaunchContext): Promise<PreparedWorker>
  parseEvent(line: string): ProviderEvent | undefined
  classifyFailure(result: ProcessResult): AgentFailure
}
```

Each provider owns:

- executable discovery and authentication preflight;
- CLI arguments and provider-specific configuration;
- MCP server configuration;
- worker instruction delivery;
- environment sanitization;
- streaming output and usage parsing;
- provider-specific model and effort validation; and
- normalized failure classification.

`PreparedWorker` contains an executable, argument array, environment overlay, working directory, input mode, output mode, and cleanup callback. It must not contain shell-interpolated command strings.

### Execution transport

```ts
type TransportId = 'process' | 'pty' | 'tmux'

interface ExecutionTransport {
  readonly id: TransportId
  launch(worker: PreparedWorker): WorkerHandle
}
```

The transport owns process lifecycle, logging, exit notification, terminal presentation, and tmux pane metadata. It does not know how Claude, Codex, or Cursor arguments are constructed.

Provider and transport compatibility is validated before worktree creation. Initially:

| Provider | process | PTY | tmux |
|---|---:|---:|---:|
| Claude | Yes | Not required | Yes |
| Codex | Yes | Not required | Yes |
| Cursor | No | Yes | Deferred |

## Configuration

The new project configuration is:

```json
{
  "workerProvider": "codex",
  "workerTransport": "process",
  "providerOptions": {
    "codex": {
      "model": null,
      "profile": null
    },
    "claude": {
      "model": "sonnet"
    }
  }
}
```

Provider options are optional. When a Codex model is omitted, MultiClaude lets the installed Codex CLI or selected profile choose its configured default. MultiClaude does not hard-code a default Codex model name.

New CLI forms are:

```bash
multiclaude init --codex
multiclaude init --claude
multiclaude init --cursor

multiclaude start --worker-provider=codex
multiclaude start --worker-transport=tmux
```

Command-line options override project configuration. Task-level provider and model values override both.

`create_run` accepts optional `workerProvider` and `workerTransport` values for a single-run override. The resolved values are persisted on the run so retries and server restarts do not change routing. When omitted, the run snapshots the project or startup defaults that were active when it was created.

### Backward compatibility

Legacy `workerRuntime` values are translated as follows:

| Legacy value | Provider | Transport |
|---|---|---|
| `claude` | Claude | process |
| `cursor` | Cursor | PTY |
| `tmux` | Claude | tmux |

Legacy configuration remains functional. MultiClaude emits one actionable deprecation warning per startup and does not rewrite configuration without an explicit user command.

## Initialization and Orchestrators

`multiclaude init --codex` establishes Codex as both the expected orchestrator and default worker provider. It writes or merges:

- `.multiclaude.json` with `workerProvider: "codex"`;
- an `AGENTS.md` MultiClaude orchestrator section;
- project-scoped MCP configuration for `multiclaude-coord`; and
- safe project-local Codex settings required by the integration.

Initialization must preserve existing `AGENTS.md` and Codex configuration using marked sections or structured merges. It must never overwrite user authentication or unrelated settings.

The first release does not infer the provider from an anonymous MCP connection. Client capability registration may be added later, but explicit initialization and configuration are the authoritative source in this release.

## Task Routing and Persistence

`plan_dag` accepts an optional provider:

```ts
{
  id: string
  title: string
  description?: string
  provider?: 'claude' | 'codex' | 'cursor'
  model?: string
  effort?: string
  dependsOn: string[]
}
```

Provider resolution order is:

1. task provider;
2. the provider persisted on the run;
3. project `workerProvider` when creating a run;
4. Claude, for backward compatibility.

Routing behavior is intentionally conservative:

- a user request to use one provider applies that provider to all tasks by default;
- mixed providers are used only when the user explicitly requests them or supplies task overrides;
- the orchestrator does not choose providers from task complexity; and
- invalid provider, model, effort, or transport combinations fail during planning or preflight before worktree creation.

The task table gains a nullable `provider` column. The agent-attempt table gains non-null resolved `provider`, nullable resolved `model`, nullable `effort`, and nullable normalized `failure_kind` columns. Attempt-level persistence is required because future retries may use a different provider from the original task.

Database migrations follow the repository's current idempotent migration pattern. Existing rows resolve to Claude when provider data is absent.

## Provider-Neutral Worker Protocol

All providers use the existing `multiclaude-worker` MCP server and workflow:

1. call `get_my_task` with the agent ID;
2. implement and test only inside the assigned worktree;
3. call `report_progress` at meaningful checkpoints; and
4. call `report_done` or `report_blocked`.

Provider-neutral worker instructions live in one canonical source. Providers may wrap those instructions in their native file or CLI format, but must not maintain divergent copies of the workflow.

An MCP completion report remains authoritative. A provider process exiting with status zero does not prove task completion. Likewise, a task already reported done is not changed to failed merely because the provider process exits abnormally afterward. Existing post-exit reconciliation is extended to use persisted task state before assigning a failure.

## Codex Provider

Codex runs through the stable non-interactive CLI interface:

```bash
codex exec \
  --cd <worktree> \
  --sandbox workspace-write \
  --ask-for-approval never \
  --json \
  <worker-prompt>
```

The adapter adds `--model` and `--profile` only when explicitly configured. Arguments are passed as an array rather than through a shell.

Before launch, the adapter:

- verifies that `codex` is installed;
- verifies authentication without consuming a coding task;
- configures the `multiclaude-worker` HTTP MCP endpoint for that invocation;
- sanitizes environment variables that would trigger nested-session behavior;
- supplies `MULTICLAUDE_AGENT_ID` and task isolation variables; and
- starts in the assigned worktree.

Codex JSONL output is copied to the standard worker log and parsed into normalized provider events. Parse failures are logged and tolerated unless they prevent authoritative completion or failure classification.

### Codex isolation

Codex starts with `workspace-write` and approval mode `never`. MultiClaude grants only the assigned worktree plus the minimum worktree-specific Git metadata directory needed to commit. It does not grant the parent checkout as a writable directory.

An integration test must demonstrate both properties before Codex support is considered complete:

- Codex can edit and commit inside its assigned worktree.
- Codex cannot modify the parent checkout through file tools, shell commands, traversal, or symlink escape.

If the installed Codex version cannot satisfy both conditions, preflight fails with an actionable compatibility error rather than falling back to unrestricted filesystem access.

## Failure Normalization

Provider-specific output maps to:

```ts
type AgentFailureKind =
  | 'not_installed'
  | 'not_authenticated'
  | 'quota_exhausted'
  | 'permission_denied'
  | 'invalid_model'
  | 'mcp_unavailable'
  | 'process_crashed'
  | 'task_failed'
```

The stored failure includes the normalized kind, provider, exit code when present, and a sanitized provider message. Secrets and full environment dumps are never stored.

Classification rules must prefer structured events and documented exit information. Text matching is a provider-local fallback with fixtures for every accepted message. Unknown failures become `process_crashed` for abnormal exits or `task_failed` for an explicit worker failure; they never become `quota_exhausted` by guesswork.

## User Interface and Observability

The TUI and web dashboard display provider separately from model and transport. Task and attempt detail views show:

- requested and resolved provider;
- model when known, otherwise `configured default`;
- execution transport;
- normalized failure kind;
- provider-specific log location; and
- token usage and cost when the provider reports enough data.

Cost calculation must not apply Claude pricing to unknown Codex or Cursor models. Unknown pricing is displayed as unavailable rather than estimated using a different provider.

## Preflight and Error Handling

Provider preflight runs before creating a worktree and returns structured diagnostics for executable availability, authentication, MCP support, selected model/profile, and transport compatibility.

A failed preflight does not consume a retry, create a branch, or create an agent attempt marked as a coding failure. It produces an actionable configuration error associated with the task and provider.

Runtime provider failures continue through the existing retry and recovery pipeline, but the first release retries with the same provider. Cross-provider failover is not enabled.

## Testing

### Contract tests

Every provider is tested against the same behavioral contract:

- preflight success and each structured failure;
- safe argument construction;
- canonical worker instructions;
- MCP configuration;
- environment sanitization;
- event and usage parsing; and
- normalized failure classification.

### Fake CLI integration tests

Fixture executables emulate Claude, Codex, and Cursor behavior without authentication or subscription usage. Fixtures cover progress, completion, blocking, malformed events, quota exhaustion, crashes, and completion followed by a non-zero exit.

### Routing and migration tests

Tests cover project defaults, run overrides, task overrides, invalid combinations, legacy `workerRuntime` translation, existing database migration, and attempt-level provider persistence.

### Isolation tests

Tests verify successful worktree edits and commits, denied parent-checkout writes, traversal and symlink escapes, and minimal Git metadata access for every supported provider/transport combination.

### Real-provider smoke tests

Real Codex and Claude tests are opt-in through explicit environment flags such as `MULTICLAUDE_CODEX_E2E=1`. Normal CI never requires provider authentication and never consumes account usage.

## Future Automatic Failover

After explicit provider routing is stable, configuration may add:

```json
{
  "providerPolicy": {
    "preferred": "claude",
    "fallback": ["codex"],
    "failoverOn": ["quota_exhausted"]
  }
}
```

Failover creates a new agent attempt with its own provider, model, logs, and cost data while preserving the task and prior attempt history. It only triggers for configured normalized failure kinds. Test failures, coding errors, merge conflicts, and unknown crashes do not silently move to another provider.

The explicit-provider release may reserve these types internally, but it does not expose configuration that appears to promise failover before the behavior exists.

## Rollout

1. Introduce provider and transport types, configuration parsing, and legacy translation without changing default behavior.
2. Refactor Claude and Cursor behind provider contracts with parity tests.
3. Add provider and attempt persistence plus routing validation.
4. Implement the Codex provider and fake-CLI integration tests.
5. Add Codex initialization and orchestrator instructions.
6. Add provider-aware TUI and web observability.
7. Run opt-in real-provider and isolation smoke tests.
8. Document configuration, migration, supported combinations, and troubleshooting.

The default remains Claude plus process transport throughout rollout. Codex is advertised as supported only after its preflight, MCP reporting, completion reconciliation, and isolation tests pass.
