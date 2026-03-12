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
npm link
```

## Run

```bash
multiclaude start
```

This starts:
- **Coordination server** on `http://localhost:7432` (MCP endpoint for agents)
- **Web dashboard** on `http://localhost:7433` (live task/agent status)
- **TUI** in your terminal (keyboard-driven status view)

Optional flags:
```bash
multiclaude start --no-tui          # skip terminal UI
multiclaude start --no-web          # skip web dashboard
multiclaude start --coord-port=8000 # custom coord server port
multiclaude start --web-port=8001   # custom web dashboard port
```

## Connect the Orchestrator

In the project directory you want to work on, run `multiclaude init` to set it up. Then launch your orchestrator agent.

### Using Claude Code (default)

```bash
multiclaude init           # or: multiclaude init --claude
claude
```

Claude Code will automatically connect to the coordination server. You should see the `multiclaude-coord` MCP server listed as connected in `/mcp`.

If the `multiclaude-coord` server shows as unauthenticated in `/mcp`, run `/mcp` and select the server to complete the OAuth flow.

### Using Cursor Agent

```bash
multiclaude init --cursor
cursor agent
```

The `--cursor` flag writes `.cursor/rules/multiclaude-orchestrator.mdc` with orchestrator instructions and skips writing `CLAUDE.md`.

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

## Using Cursor Agent

MultiClaude supports [Cursor Agent CLI](https://cursor.com) as an alternative to Claude Code for both the orchestrator and worker agents.

### Prerequisites

- [Cursor](https://cursor.com) installed with CLI available (`cursor --version`)
- Active **Cursor Pro or Business** subscription (required for agent and MCP features)

### Setup

```bash
# In your project directory, choose Cursor as the runtime at init time:
multiclaude init --cursor

# Start the coordination server (from the multiclaude repo):
multiclaude start

# Run the orchestrator using Cursor Agent:
cd /path/to/your/project
cursor agent
```

The `--cursor` flag:
- Saves `workerRuntime: "cursor"` in `.multiclaude.json`
- Writes `.cursor/rules/multiclaude-orchestrator.mdc` with orchestrator instructions
- Skips writing `CLAUDE.md`

On `multiclaude start`, the server also writes:
- `~/.cursor/mcp.json` — registers the `multiclaude-coord` MCP endpoint globally
- `~/.cursor/cli-config.json` — pre-approves the MultiClaude MCP tools so Cursor doesn't prompt for each one

### Known Limitations

- **PTY requirement:** Cursor CLI requires a real TTY and hangs indefinitely when spawned as a plain subprocess. MultiClaude uses `node-pty` to wrap worker processes in a pseudo-TTY.
- **Per-agent MCP config:** Cursor does not support per-invocation MCP config flags (unlike Claude Code's `--mcp-config`). Workers use project-scoped `.cursor/mcp.json` written into their git worktree as a workaround. ([Cursor forum thread](https://forum.cursor.com/t/per-agent-mcp-configuration/153716))
- **No `--dangerously-skip-permissions` equivalent:** Cursor manages permissions via `~/.cursor/cli-config.json`. MultiClaude pre-populates this with the required tool allow-list on server start.
- **Model availability:** Cursor Agent uses whatever models are configured in your Cursor subscription. Claude models are available if enabled in your Cursor settings.

### Comparison

| Feature | Claude Code (`--claude`) | Cursor Agent (`--cursor`) |
|---|---|---|
| Subscription | Anthropic (API or Max) | Cursor Pro/Business |
| Model choice | Claude models only | Any model in Cursor |
| MCP support | Full | Full (v1.6+) |
| Headless/CI use | Yes | Yes (via PTY wrapper) |
| Skip-permissions flag | `--dangerously-skip-permissions` | `~/.cursor/cli-config.json` allow-list |
| Init flag | `--claude` (default) | `--cursor` |
| System instructions | `CLAUDE.md` | `.cursor/rules/*.mdc` |

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
```

## Agent Observability

The agent observability MCP server has been moved to its own repository:
**[dushshantha/agent-observability](https://github.com/dushshantha/agent-observability)**

## Architecture Notes

- **Transport:** MCP over Streamable HTTP (`type: "http"`) with OAuth 2.0 auto-auth
- **State:** SQLite with WAL mode; task statuses: `pending → in_progress → done | failed | cancelled`
- **DAG scheduling:** `getReadyTasks()` returns tasks whose blockers are all `done`
- **Git isolation:** Workers get their own branch (`mc/task-{id}`) and merge into `mc/integration`
- **Retry logic:** Failed tasks retry up to `max_retries` times before escalating to the user
