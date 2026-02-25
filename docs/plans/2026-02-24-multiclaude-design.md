# MultiClaude — Design Document

**Date:** 2026-02-24
**Status:** Approved

## Overview

MultiClaude is a multi-agent orchestration system for Claude Code. It lets you describe an epic in natural language (or point to a GitHub Issue / Jira ticket), and the system decomposes it into tasks, spawns parallel Claude Code worker agents, coordinates dependencies, handles failures, and manages git merges — all while remaining interruptible and collaborative.

---

## Core Architecture

```
YOU  ←──natural language──→  ORCHESTRATOR AGENT
                              (Claude Code instance)
                                      │
                          MCP Coordination Server
                          (the nervous system)
                         /         |          \
                    Worker 1   Worker 2   Worker N
                   (worktree) (worktree) (worktree)

              TUI Dashboard  +  Web UI (:3000)
```

### Three Layers

1. **Orchestrator Agent** — A Claude Code instance you launch once and talk to naturally. It reasons about task decomposition, dependency ordering, when to spawn/merge/escalate. Has a privileged MCP toolset for managing the whole system.

2. **MCP Coordination Server** — A lightweight local server and the only hardcoded process. Maintains shared state: DAG, task statuses, worktree registry, agent logs. Both orchestrator and workers connect to it with role-scoped toolsets.

3. **Worker Agents** — Claude Code instances spawned by the orchestrator, each in their own git worktree, connected to the MCP server with a worker-scoped toolset.

---

## Input Sources

- **Primary:** GitHub Issues / Jira tickets via user-configured MCP servers (tool-agnostic — users bring their own MCP connectors)
- **Fallback:** Plain text or markdown (e.g., paste a design doc, write a description)

---

## Task Coordination: DAG Scheduler

The orchestrator plans a dependency graph (DAG) before any work begins:

- Tasks with no dependencies start immediately
- Downstream tasks are blocked until their dependencies are merged
- The orchestrator reasons about the DAG naturally and can reprioritize mid-flight based on your instructions

---

## MCP Tool Split

### Orchestrator-scoped tools
| Tool | Description |
|---|---|
| `ingest_epic(source, id)` | Fetch epic from GitHub / Jira / file |
| `plan_dag(epic)` | Decompose into tasks with dependencies |
| `spawn_worker(task_id)` | Create worktree + launch Claude Code instance |
| `get_system_status()` | Full view of all agents, tasks, DAG state |
| `merge_task(task_id)` | Merge completed worktree into integration branch |
| `cancel_task(task_id)` | Cancel a running or pending task |
| `reprioritize(task_id)` | Adjust task priority in the DAG |
| `escalate_to_user(task_id, reason, context)` | Interrupt user for input |

### Worker-scoped tools
| Tool | Description |
|---|---|
| `get_my_task()` | Fetch assigned task + full context |
| `report_progress(message)` | Heartbeat / status update |
| `report_done(summary)` | Signal completion, trigger merge queue |
| `report_blocked(reason, error)` | Trigger auto-retry or escalation |
| `read_contract(interface_name)` | Read shared interfaces from planning phase |

---

## Lifecycle Flow

```
You: "build the auth epic from GitHub issue #42"
  └→ Orchestrator ingests issue, reads linked subtasks
  └→ Plans DAG:
       [design API contract]
           → [implement JWT] + [implement OAuth]   (parallel)
               → [write tests]
                   → [update docs]
  └→ Spawns Worker 1 for API contract (others wait)
  └→ Worker 1 completes → orchestrator merges → unblocks JWT + OAuth workers
  └→ Workers 2 & 3 run in parallel on their worktrees
  └→ Worker 2 hits build failure → auto-retries (up to 3x)
  └→ Still failing → orchestrator pings you:
       "Worker 2 stuck on JWT refresh logic, here's the error"
  └→ You: "tell it to use the redis session store instead"
  └→ Orchestrator relays context → Worker 2 resumes
  └→ All tasks done → orchestrator proposes final merge to main, awaits your approval
```

---

## Git Isolation Strategy

- **Default:** `git worktree add` per task, branch named `mc/task-{id}`
- **Complex tasks:** Full clone into temp directory (orchestrator decides based on task risk/scope)
- **Integration branch:** `mc/integration` — workers merge here first; you approve final merge to main

---

## Failure Handling

1. Agent hits failure (broken build, failing tests, stuck)
2. Auto-retry: re-prompt same agent with full error context (up to 3 attempts)
3. If retries exhausted: orchestrator escalates to you with full context
4. You respond naturally — orchestrator relays your guidance to the agent
5. Agent resumes

---

## Interaction Model

- **Collaborative** — orchestrator runs autonomously but you can interrupt at any time
- Ask status: "what's happening with the OAuth task?"
- Redirect: "deprioritize the docs task, focus on tests"
- Cancel: "kill the refactor worker, we're changing direction"
- High-risk actions (merges to main, destructive ops) always require your approval

---

## Monitoring

### TUI (terminal, always visible)
```
MultiClaude  ■ 3 running  ✓ 2 done  ⚠ 1 blocked       [q]uit [p]ause [s]tatus

 TASK                    AGENT    STATUS      BRANCH
 ──────────────────────────────────────────────────────
 ✓ API Contract          w-1      merged      mc/task-1
 ■ JWT Implementation    w-2      retrying    mc/task-2  ⚠ attempt 2/3
 ■ OAuth Implementation  w-3      in progress mc/task-3  ████░░ 60%
 ○ Write Tests           -        waiting     (blocked by w-2, w-3)
 ○ Update Docs           -        waiting     (blocked by tests)

 [w-2 output] ──────────────────────────────────────────
 > Running test suite... 3 failures in jwt.refresh.test.ts
 > Error: redis connection refused at localhost:6379
```

### Web UI (`:3000`)
- Visual DAG graph with live status colors
- Click any node → full agent output + diff preview
- Merge approval UI for high-risk operations

---

## Technology Decisions

| Concern | Decision | Rationale |
|---|---|---|
| Agent control | MCP server (fallback: subprocess pipes) | Agentic, structured protocol |
| Orchestrator | Claude Code instance (natural language) | Flexible reasoning, no hardcoded scheduler logic |
| Worker isolation | Git worktrees (fallback: full clone) | Lightweight, fast, native git |
| Execution environment | Local subprocesses | Simple, ship fast, scale later |
| Issue tracker integration | User-configured MCPs | Tool-agnostic, composable |
| TUI framework | TBD (blessed / ink) | Live terminal dashboard |
| Web UI | TBD (local React app) | Rich DAG visualization |
| State store | MCP Coordination Server (embedded) | Single source of truth for all agents |
