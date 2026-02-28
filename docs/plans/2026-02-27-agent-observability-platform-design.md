# Agent Observability Platform — Design Document

**Date:** 2026-02-27
**Status:** Approved

---

## Problem

Companies adopting AI coding agents have no way to answer: *is it working?*

They cannot track which agents their developers are using, what it costs per task, whether that spend produces output, or where budget is being wasted. As AI agent adoption scales from individual developers to entire engineering orgs, this visibility gap becomes a financial and strategic liability.

---

## Product Vision

A cloud SaaS observability platform for AI coding agents — think Datadog but for developer AI usage.

It tells engineering leaders what their agents cost, what they produced, and where budget is being wasted. It tells individual developers how efficient they are and gives them a record of AI-assisted work.

**Two personas, one platform:**
- **Engineering director** — org-wide spend, team adoption, ROI trends, waste alerts
- **Developer** — personal cost/output ratio, AI-assisted PR history, session breakdown

---

## Scope

**In MVP:** Claude Code only, GitHub + Jira via MCP, ROI dashboard, waste detection, developer personal view, multi-tenant org management.

**Explicitly out of MVP:** Cursor/Windsurf support, Confluence, budget alerts, public API, cross-company benchmarking, self-hosted deployment.

---

## Core Value Loop

```
Instrument → Attribute → Measure → Optimize
    │              │           │          │
 Collect       Link agent   Cost per   Surface
 Claude Code   sessions to  PR, ticket, waste and
 session data  PRs + Jira   developer   coach devs
               tickets      velocity
```

---

## Data Collection Architecture

### MCP Collection Server (primary)

The platform exposes a multi-tenant MCP server endpoint. Developers (or IT via MDM) add one entry to their Claude Code MCP config:

```json
{
  "mcpServers": {
    "agentlens": {
      "type": "http",
      "url": "https://api.yourproduct.com/collect/{org_slug}"
    }
  }
}
```

Every Claude Code session automatically connects and reports via MCP tools:

```
report_session_start(task_description, git_branch)
report_cost(tokens_in, tokens_out, cost_usd)
report_task_complete(summary, pr_url)
```

The MCP server also uses system prompt injection to instruct Claude Code to call these tools at key moments — transparently, without developer friction.

**Privacy boundary:** only metadata is collected (tokens, cost, timestamps, file paths). No code content, no prompt content, no response content.

### GitHub + Jira via MCP Clients (attribution)

The platform backend acts as an MCP client, connecting to GitHub and Jira MCP servers to enrich sessions with outcome data:

```
Every 15 min:
  for sessions with no outcome linked →
    query GitHub MCP: find PR for branch/timestamp →
    query Jira MCP: find ticket linked to PR →
    link outcome to session

After 48h with no outcome → flag session as waste
```

This approach requires no custom OAuth flows. Any system with an MCP server works automatically — GitHub, Jira, Linear, Confluence, Azure DevOps. As the MCP ecosystem grows, integrations grow for free.

---

## Data Model

```
Organization → Team → Developer → Session → Cost
                                      │
                              Git PR / Jira Ticket → Outcome
```

**Session** — atomic unit, one Claude Code MCP connection:
```
session_id, org_id, developer_id, agent_type,
started_at, ended_at, duration_secs,
tokens_in, tokens_out, cost_usd,
git_branch, git_repo, working_dir
```

**Outcome** — linked after the fact:
```
outcome_id, session_id(s),
type: [pr | ticket | commit | none],
pr_url, lines_added, lines_removed, review_cycles,
ticket_id, story_points, cycle_time_hours
```

**Waste signal** — derived, a session is flagged when:
- Cost > threshold AND no outcome linked within 48h
- Duration > 2h with no git activity
- Repeated sessions on same branch with no PR

**Key aggregations:**
```
cost_per_pr       = sum(session.cost) / count(linked prs)
cost_per_ticket   = sum(session.cost) / count(linked tickets)
waste_ratio       = sum(flagged_session.cost) / sum(session.cost)
adoption_rate     = active_developers / total_developers
```

**Multi-tenancy:** every row scoped to `org_id`, derived from the MCP endpoint slug.

---

## Core Features (MVP)

### Engineering Director View

**ROI Panel**
```
This month                    vs last month
─────────────────────────────────────────────
Avg cost per PR        $1.24        ↓ 18%
Avg cost per ticket    $3.80        ↓ 22%
Total AI spend         $4,840       ↑ 12%
Story points delivered   312        ↑ 34%
```

**Waste Panel**
```
⚠ $840 in sessions with no linked outcome (last 30 days)

Top waste sources:
  marcus@acme.com     $312  — 8 sessions, no PR or ticket
  john@acme.com       $228  — long sessions, no git activity
  Team: Platform Eng  $180  — repeated sessions, same branch
```

**Adoption Heatmap**
```
Team             Devs using agents    Avg daily spend
──────────────────────────────────────────────────────
Frontend              8/10                $12.40
Backend               4/12  ← low         $8.20
Platform              6/6                 $18.60
```

### Developer View

Personal dashboard — their data only:
```
Your AI usage this month
────────────────────────────────────────
Total spend          $142
PRs shipped            11    ($12.90/PR)
Tickets closed          8    ($17.75/ticket)
Waste flagged          $18   (2 sessions)

Recent sessions:
  feat/PROJ-489   $4.20  → PR #412 merged    ✓
  feat/PROJ-501   $8.80  → PR open, in review
  debug/auth-fix  $1.10  → commit pushed     ✓
  feat/PROJ-499  $12.40  → ⚠ no outcome yet
```

---

## Platform Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Developer Machine                  │
│  Claude Code → MCP Collection Server (your product) │
└─────────────────────────┬───────────────────────────┘
                          │ session events (real-time)
          ┌───────────────▼───────────────┐
          │      Collection Service        │
          │  MCP server + event ingestion  │
          │  TypeScript + Express          │
          └───────────────┬───────────────┘
                          │ writes
          ┌───────────────▼───────────────┐
          │           Database             │
          │  PostgreSQL (orgs, teams,      │
          │  developers, sessions)         │
          │  + TimescaleDB (time-series)   │
          └───────────────┬───────────────┘
                          │ reads
          ┌───────────────▼───────────────┐
          │        Analytics API           │
          │  Aggregations, waste signals,  │
          │  MCP client (GitHub, Jira)     │
          └───────────────┬───────────────┘
                          │
          ┌───────────────▼───────────────┐
          │          Dashboard             │
          │  Next.js + Tremor charts       │
          │  Director view + Dev view      │
          └───────────────────────────────┘
```

### Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Collection server | TypeScript + Express | Proven in MultiClaude |
| MCP SDK | @modelcontextprotocol/sdk | Already a dependency |
| Database | PostgreSQL + TimescaleDB | Relational + time-series in one |
| Analytics API | TypeScript + Fastify | Fast, lightweight |
| Dashboard | Next.js + Tremor | React-native charts, SaaS-ready |
| Auth | Clerk | SSO + SAML ready for enterprise |
| Infrastructure | Railway (start) → AWS (scale) | Ship fast, migrate when needed |

---

## MVP Build Order

**Phase 1 — Data pipe (weeks 1–3)**
- Multi-tenant MCP collection server
- PostgreSQL schema: orgs, developers, sessions, costs
- Org onboarding: sign up → get MCP endpoint URL → copy config snippet
- Basic session list UI (prove data is arriving)

**Phase 2 — Attribution (weeks 4–6)**
- Backend MCP client: GitHub MCP server integration
- Backend MCP client: Jira MCP server integration
- Waste detection algorithm
- Cost per PR + cost per ticket calculations

**Phase 3 — Dashboard (weeks 7–9)**
- Director view: ROI panel + waste panel + adoption heatmap
- Developer view: personal cost/output breakdown + session history
- Auth via Clerk (SSO ready from day one)
- Team hierarchy (org → team → developer)

**Target:** paying customer by week 9.

---

## Competitive Advantage

- **MCP-native architecture** — as MCP becomes the standard agent protocol, every new agent that supports MCP becomes a free integration
- **MultiClaude foundation** — 6-month head start on Claude Code data vs. any competitor starting from scratch
- **Zero friction onboarding** — one config snippet, no installer, no desktop agent, works with existing Claude Code setup
- **Output-linked costs** — not just "you spent $X" but "you spent $X to deliver Y story points" — no competitor does this today
