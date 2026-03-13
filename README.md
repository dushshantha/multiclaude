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
multiclaude start --no-tui            # skip terminal UI
multiclaude start --no-web            # skip web dashboard
multiclaude start --open-terminals    # open a terminal window per worker
multiclaude start --coord-port=8000   # custom coord server port
multiclaude start --web-port=8001     # custom web dashboard port
```

### `--open-terminals`

When `--open-terminals` is passed, MultiClaude opens a dedicated terminal window for each worker as it spawns. Each window tails the worker's log file and shows the agent's output as clean, readable text — the same conversational Claude output you see in a normal Claude Code session, not raw JSON or XML.

Terminal priority: tmux new-window (if `$TMUX` is set) → macOS Terminal.app → Linux terminal emulators (gnome-terminal, xterm, konsole, etc.). If no supported terminal is found, the tail command is printed to the console so you can open it manually.

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

## Example Prompts

These are the kinds of tasks you can give the orchestrator — plain natural language, no tool names needed. The orchestrator handles decomposition and coordination automatically.

**Greenfield features:**
```
Build a REST API with auth and user management
```
```
Add dark mode to the web UI
```
```
Implement Redis caching for expensive database queries
```

**Maintenance and migrations:**
```
Migrate Jest to Vitest and fix any broken tests
```
```
Add pagination and filtering to all list endpoints
```
```
Add OpenAPI/Swagger docs auto-generated from the route definitions
```

**Infrastructure and tooling:**
```
Set up CI with GitHub Actions: lint, test, and build on every PR
```
```
Add rate limiting and request logging middleware
```
```
Write a load testing script and fix any bottlenecks found
```

**Open-ended:**
```
Work on all open GitHub issues and create PRs as you go
```

The orchestrator will break each of these into parallel tasks, show you the dependency graph, and ask for your approval before spawning any workers. You can revise the plan before it starts.

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
