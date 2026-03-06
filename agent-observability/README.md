# Agent Observability

Track cost, attribution, and waste for Claude Code sessions across your engineering org.

## Architecture

```
┌─────────────────┐     MCP tools      ┌──────────────────────┐
│   Claude Code   │ ─────────────────► │  Collection Server   │
│  (developer)    │                    │  collection/server.ts │
└─────────────────┘                    └──────────┬───────────┘
                                                   │ Drizzle ORM
                                                   ▼
                                       ┌──────────────────────┐
                                       │      PostgreSQL       │
                                       │     db/schema.ts      │
                                       └──────────┬───────────┘
                                                   │
                              ┌────────────────────┼────────────────────┐
                              ▼                    ▼                    ▼
                  ┌───────────────────┐ ┌──────────────────┐ ┌─────────────────┐
                  │  Attribution Job  │ │   Waste Detector  │ │  Analytics API  │
                  │ attribution/      │ │  waste/index.ts   │ │  api/server.ts  │
                  │   engine.ts       │ │  (every 15 min)   │ │                 │
                  └───────────────────┘ └──────────────────┘ └────────┬────────┘
                                                                        │ REST
                                                                        ▼
                                                           ┌─────────────────────┐
                                                           │   Next.js Dashboard │
                                                           │  dashboard/         │
                                                           └─────────────────────┘
```

### Layers

| Layer | File | Responsibility |
|---|---|---|
| **Collection Server** | `src/collection/server.ts` | Multi-tenant MCP server. Authenticates Claude Code instances via bearer tokens, receives telemetry, writes to PostgreSQL |
| **Database Schema** | `src/db/schema.ts` | Drizzle schema for `orgs`, `developers`, `sessions`, `outcomes`, `waste_sessions` |
| **Analytics** | `src/analytics/index.ts` | Aggregates cost-per-PR, cost-per-ticket, and total waste spend per org |
| **Analytics API** | `src/api/server.ts` | Fastify REST API — `GET /orgs/:orgId/metrics` and `GET /orgs/:orgId/sessions` |
| **Attribution Engine** | `src/attribution/engine.ts` | Links sessions to GitHub PRs and Jira tickets based on git branch metadata |
| **Waste Detector** | `src/waste/index.ts` | Flags sessions older than 48 hours with no linked outcome as waste |

## How It Works

### 1. MCP config for developers

Add this to your Claude Code MCP config (`~/.claude/claude_desktop_config.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "agent-observability": {
      "type": "http",
      "url": "http://localhost:YOUR_PORT/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_ORG_TOKEN"
      }
    }
  }
}
```

The collection server issues org tokens via `oauthProvider.issueToken(orgSlug)` — run this once per org at setup time.

### 2. MCP tools

Claude Code reports telemetry using three tools exposed by the collection server:

| Tool | When called | What it records |
|---|---|---|
| `report_session_start` | Session begins | git branch, repo, working dir, task description, developer ID |
| `report_cost` | Mid-session or on completion | tokens in/out, cost in USD |
| `report_task_complete` | Task finishes | duration, final token counts, final cost |

### 3. Attribution (every 15 min)

The attribution engine (`src/attribution/engine.ts`) runs on a schedule and scans all sessions that have no linked outcome. For each session:

1. **GitHub**: looks for a merged or open PR whose head branch matches `session.gitBranch` in the session's `gitRepo`
2. **Jira**: parses the branch name for a ticket key (e.g. `PROJ-123`) and fetches ticket metadata

If a match is found, an `outcome` row is inserted linking the session to the PR or ticket.

### 4. Waste detection (48h threshold)

`src/waste/index.ts` checks all sessions. Any session older than 48 hours with no linked outcome is flagged as waste and recorded in `waste_sessions` with reason `no_outcome_48h`. Waste cost rolls up into the org-level metrics returned by the API.

## How to Run Locally

### Prerequisites

- Node.js 18+
- PostgreSQL (local or remote)

### Setup

```bash
cd agent-observability
npm install
```

### Environment variables

Create a `.env` file in `agent-observability/`:

```env
DATABASE_URL=postgres://user:password@localhost:5432/agent_observability
COLLECTION_PORT=7433
```

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | *(required)* | PostgreSQL connection string |
| `COLLECTION_PORT` | `7433` | Port for the MCP collection server |
| `API_PORT` | `3001` | Port for the analytics REST API |

Apply the schema to your database:

```bash
npm run db:push
```

### Start the collection server

```bash
npm start
```

The collection server listens on `127.0.0.1:7433` by default (configurable via `COLLECTION_PORT`). The port is printed on startup.

### Start the analytics API

The analytics API is started as part of the same process. It exposes:

- `GET /health` — health check
- `GET /orgs/:orgId/metrics` — cost-per-PR, cost-per-ticket, total waste
- `GET /orgs/:orgId/sessions` — list of all sessions for the org

### Start the dashboard

```bash
cd dashboard
npm install
npm run dev
```

The Next.js dashboard will be available at `http://localhost:3000`.

## Docker / Local Setup

Use Docker Compose to run PostgreSQL locally with no manual database install required.

### Step-by-step

1. **Start PostgreSQL**

   ```bash
   docker compose up -d
   ```

2. **Copy the example env file**

   ```bash
   cp .env.example .env
   ```

3. **Install dependencies**

   ```bash
   npm install
   ```

4. **Apply the database schema**

   ```bash
   npm run db:push
   ```

5. **Start the server**

   ```bash
   npm start
   ```

### Teardown

Stop the container (data is preserved in the named volume):

```bash
docker compose down
```

Stop the container **and delete all data**:

```bash
docker compose down -v
```
