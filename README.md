# MultiClaude

Multi-agent Claude Code orchestration system. Give an orchestrator Claude Code instance an epic, and it automatically decomposes it into tasks, spawns parallel worker agents, coordinates dependencies via a DAG, and monitors progress in a live TUI and web dashboard.

## How It Works

```
You (natural language)
       │
       ▼
┌─────────────────────┐
│  Orchestrator Agent │  ← Claude Code instance you talk to
│  (Claude Code)      │    Uses MCP tools to plan & coordinate
└──────────┬──────────┘
           │ MCP (HTTP)
           ▼
┌─────────────────────┐
│  MultiClaude Server │  ← Coordination server (port 7432)
│  SQLite + DAG       │    Tracks tasks, agents, dependencies
└──────┬──────┬───────┘
       │      │
       ▼      ▼
  Worker    Worker      ← Parallel Claude Code subagents
  Agent 1   Agent 2       Each works on one task in isolation
```

The orchestrator has MCP tools to plan a DAG (`plan_dag`), register workers (`spawn_worker`), monitor status (`get_system_status`), and cancel tasks (`cancel_task`). Worker agents have tools to get their assignment (`get_my_task`), report progress (`report_progress`), and signal completion or failure (`report_done`, `report_blocked`).

### Planning Loop

Before any workers are spawned, the orchestrator runs a planning loop. After calling `plan_dag`, it displays an ASCII DAG visualization of all tasks and their dependencies, then uses `AskUserQuestion` to ask the user to **Proceed** or **Revise**. If the user chooses Revise, they can describe changes (add tasks, remove tasks, adjust dependencies), and the orchestrator calls `plan_dag` again with the updated task list, displays the new visualization, and asks for approval again. Only once the user explicitly approves does the orchestrator begin spawning workers.

## Prerequisites

- Node.js 18+
- [Claude Code](https://claude.ai/code) CLI (`claude`)
- npm

## Install

```bash
git clone https://github.com/dushshantha/multiclaude.git
cd multiclaude
npm install
```

## Run

```bash
npm start
```

This starts:
- **Coordination server** on `http://localhost:7432` (MCP endpoint for agents)
- **Web dashboard** on `http://localhost:7433` (live task/agent status)
- **TUI** in your terminal (keyboard-driven status view)

Optional flags:
```bash
npm start -- --no-tui          # skip terminal UI
npm start -- --no-web          # skip web dashboard
npm start -- --coord-port=8000 # custom coord server port
npm start -- --web-port=8001   # custom web dashboard port
```

## Connect the Orchestrator

Once the server is running, launch Claude Code with the orchestrator MCP config:

```bash
claude --mcp-config ~/.claude/multiclaude-orchestrator-mcp.json
```

Claude Code will automatically complete an OAuth flow (first time only) and connect to the coordination server. You should see the `multiclaude-coord` MCP server listed as connected in `/mcp`.

> **Note:** Ports 7432 (coord) and 7433 (web) are reserved for MultiClaude. Don't kill processes on these ports during agent tasks.

## Test It Locally

### 1. Verify the connection
```
Call get_system_status to show me the current state of the coordination server.
```

### 2. Plan a parallel DAG
```
Use plan_dag to break this epic into tasks:
- Build a REST API with three endpoints: GET /users, POST /users, DELETE /users/:id
- Each endpoint is independent and can be built in parallel
- There should be a final integration task that depends on all three
```

### 3. Plan with a dependency chain
```
Use plan_dag to decompose this work:
1. Set up a SQLite database schema
2. Write a data access layer (depends on schema)
3. Write unit tests for the data access layer (depends on schema)
4. Build an API server (depends on data access layer)
5. Write API integration tests (depends on API server and data access layer)

Then call get_system_status and tell me which tasks are ready to start immediately.
```

### 4. Simulate a full worker flow
```
Use plan_dag to create two tasks: "Write a hello world function" and "Write tests for it"
where tests depend on the function. Then use spawn_worker to assign the first task to
agent "agent-001". Call get_system_status to confirm the assignment.
```

### 5. Full end-to-end
```
I want to build a small CLI tool that converts JSON to CSV. Please:
1. Break it into parallel subtasks using plan_dag
2. Show me get_system_status to confirm the DAG
3. Dispatch workers to all ready tasks using spawn_worker
4. Monitor with get_system_status and dispatch the next tasks as they complete
```

### 6. Try the planning loop
```
Use plan_dag to break this feature into tasks:
- Add a user login endpoint
- Add a user logout endpoint
- Add session middleware (depends on login and logout)
- Write integration tests (depends on session middleware)

Show me the ASCII DAG visualization, then I'll tell you whether to proceed or revise.
```
The orchestrator will display the task graph and ask: **"Does this plan look good? Proceed / Revise"**
If you choose Revise, describe what to change (e.g. "split the middleware task into two") and the orchestrator will regenerate the DAG and ask again. Once you choose Proceed, workers are spawned immediately.

## Run Tests

```bash
npm test
```

31 tests across state management, DAG engine, MCP tool handlers, git worktrees, and the server.

## Project Structure

```
src/
  server/
    index.ts              # MCP coordination server (Express + OAuth + Streamable HTTP)
    state/
      db.ts               # SQLite setup (WAL mode)
      tasks.ts            # Task CRUD
      dag.ts              # DAG engine (dependency resolution)
      agents.ts           # Agent registry
    tools/
      orchestrator.ts     # plan_dag, get_system_status, cancel_task
      worker.ts           # get_my_task, report_progress, report_done, report_blocked
  git/
    worktree.ts           # createWorktree, removeWorktree
    merge.ts              # ensureIntegrationBranch, mergeWorktreeBranch
  spawner/index.ts        # spawnWorker, buildWorkerMcpConfig
  tui/index.tsx           # Ink TUI dashboard
  web/server.ts           # Web dashboard (SSE live updates)
  cli.ts                  # Entry point
prompts/
  orchestrator.md         # System prompt for the orchestrator Claude Code instance
  worker.md               # System prompt for worker Claude Code instances
tests/                    # Vitest test suite
agent-observability/      # Agent observability sub-project
  mcp-collector/          # MCP collection server (captures tool calls and agent events)
  db/                     # PostgreSQL schema and migrations
  attribution/            # Attribution engine (links outcomes back to agent actions)
  api/                    # Analytics API (query agent activity, costs, outcomes)
  dashboard/              # Next.js dashboard (visualize agent runs, token usage, task traces)
```

## Architecture Notes

- **Transport:** MCP over Streamable HTTP (`type: "http"`) with OAuth 2.0 auto-auth
- **State:** SQLite with WAL mode; task statuses: `pending → in_progress → done | failed | cancelled`
- **DAG scheduling:** `getReadyTasks()` returns tasks whose blockers are all `done`
- **Git isolation:** Workers get their own branch (`mc/task-{id}`) and merge into `mc/integration`
- **Retry logic:** Failed tasks retry up to `max_retries` times before escalating to the user
