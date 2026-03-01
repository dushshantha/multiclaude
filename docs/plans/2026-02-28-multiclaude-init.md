# `multiclaude init` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `multiclaude init` command so users can run `claude` normally in any project folder — no `--mcp-config` flag, no special session directory — just `cd myproject && claude`.

**Architecture:** Extract init logic into `src/init.ts`. The `init` command writes two things into the project directory: an MCP server entry in `.claude/settings.local.json` and the orchestrator CLAUDE.md content as a fenced section in the project's `CLAUDE.md`. The `start` command loses its session-directory hack and instead tells users to run `multiclaude init`.

**Tech Stack:** Node.js built-in `fs`, TypeScript, Vitest

---

### Task 1: Create `src/init.ts`

**Files:**
- Create: `src/init.ts`

**Step 1: Write the failing tests**

Create `tests/init.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runInit, MULTICLAUDE_PERMISSIONS } from '../src/init.js'

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `mc-init-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('runInit', () => {
  it('creates .claude/settings.local.json with MCP server and permissions', () => {
    runInit({ coordPort: 7432, projectDir: testDir })

    const settingsPath = join(testDir, '.claude', 'settings.local.json')
    expect(existsSync(settingsPath)).toBe(true)

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(settings.mcpServers?.['multiclaude-coord']).toEqual({
      type: 'http',
      url: 'http://localhost:7432/orchestrator',
    })
    expect(settings.permissions?.allow).toContain('mcp__multiclaude-coord__plan_dag')
  })

  it('merges with existing settings without overwriting unrelated keys', () => {
    const claudeDir = join(testDir, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify({
      permissions: { allow: ['Bash(git:*)'] },
      someOtherKey: 'preserved',
    }))

    runInit({ coordPort: 7432, projectDir: testDir })

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'))
    expect(settings.someOtherKey).toBe('preserved')
    expect(settings.permissions.allow).toContain('Bash(git:*)')
    expect(settings.permissions.allow).toContain('mcp__multiclaude-coord__plan_dag')
  })

  it('does not duplicate permissions when run twice', () => {
    runInit({ coordPort: 7432, projectDir: testDir })
    runInit({ coordPort: 7432, projectDir: testDir })

    const settings = JSON.parse(readFileSync(join(testDir, '.claude', 'settings.local.json'), 'utf-8'))
    const planDagCount = settings.permissions.allow.filter(
      (p: string) => p === 'mcp__multiclaude-coord__plan_dag'
    ).length
    expect(planDagCount).toBe(1)
  })

  it('creates CLAUDE.md with multiclaude section when file does not exist', () => {
    runInit({ coordPort: 7432, projectDir: testDir })

    const claudeMd = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain('<!-- multiclaude:start -->')
    expect(claudeMd).toContain('<!-- multiclaude:end -->')
    expect(claudeMd).toContain('MultiClaude Orchestrator')
  })

  it('appends multiclaude section to existing CLAUDE.md', () => {
    writeFileSync(join(testDir, 'CLAUDE.md'), '# My Project\n\nExisting content.\n')

    runInit({ coordPort: 7432, projectDir: testDir })

    const claudeMd = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain('# My Project')
    expect(claudeMd).toContain('Existing content.')
    expect(claudeMd).toContain('<!-- multiclaude:start -->')
  })

  it('replaces existing multiclaude section on re-run (idempotent content)', () => {
    runInit({ coordPort: 7432, projectDir: testDir })
    runInit({ coordPort: 7432, projectDir: testDir })

    const claudeMd = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8')
    const startCount = (claudeMd.match(/<!-- multiclaude:start -->/g) ?? []).length
    expect(startCount).toBe(1)
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
cd /Users/marcus/Developer/MultiClaude && npm test -- tests/init.test.ts
```

Expected: all fail with "Cannot find module '../src/init.js'"

**Step 3: Implement `src/init.ts`**

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const MULTICLAUDE_PERMISSIONS = [
  'mcp__multiclaude-coord__get_system_status',
  'mcp__multiclaude-coord__plan_dag',
  'mcp__multiclaude-coord__spawn_worker',
  'mcp__multiclaude-coord__cancel_task',
  'mcp__multiclaude-coord__complete_task',
  'mcp__multiclaude-coord__get_my_task',
  'mcp__multiclaude-coord__report_progress',
  'mcp__multiclaude-coord__report_done',
  'mcp__multiclaude-coord__report_blocked',
  'Bash(npm install:*)',
  'Bash(npm test:*)',
  'Bash(npm start:*)',
  'Bash(node:*)',
  'Bash(curl:*)',
  'Bash(lsof:*)',
]

export interface InitOptions {
  coordPort?: number
  projectDir?: string
}

export function runInit(opts: InitOptions = {}): void {
  const coordPort = opts.coordPort ?? 7432
  const projectDir = resolve(opts.projectDir ?? process.cwd())

  updateSettings(projectDir, coordPort)
  updateClaudeMd(projectDir)

  console.log(`✓ MultiClaude initialized in ${projectDir}`)
  console.log(`  .claude/settings.local.json — MCP server + permissions added`)
  console.log(`  CLAUDE.md — orchestrator instructions added`)
  console.log(`\nStart MultiClaude: multiclaude start`)
  console.log(`Then just run:     claude   (from this directory)`)
}

function updateSettings(projectDir: string, coordPort: number): void {
  const claudeDir = join(projectDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })

  const settingsPath = join(claudeDir, 'settings.local.json')
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch {
      // malformed JSON — start fresh
    }
  }

  // Merge mcpServers
  const mcpServers = (settings.mcpServers as Record<string, unknown> | undefined) ?? {}
  mcpServers['multiclaude-coord'] = {
    type: 'http',
    url: `http://localhost:${coordPort}/orchestrator`,
  }
  settings.mcpServers = mcpServers

  // Merge permissions.allow (deduplicated)
  const permissions = (settings.permissions as { allow?: string[] } | undefined) ?? {}
  const existing = permissions.allow ?? []
  const merged = Array.from(new Set([...existing, ...MULTICLAUDE_PERMISSIONS]))
  settings.permissions = { ...permissions, allow: merged }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

function updateClaudeMd(projectDir: string): void {
  const claudeMdPath = join(projectDir, 'CLAUDE.md')
  const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf-8') : ''

  const orchestratorContent = loadOrchestratorContent()
  const section = `<!-- multiclaude:start -->\n${orchestratorContent}\n<!-- multiclaude:end -->`

  const START = '<!-- multiclaude:start -->'
  const END = '<!-- multiclaude:end -->'

  let updated: string
  if (existing.includes(START)) {
    // Replace existing section
    const before = existing.slice(0, existing.indexOf(START))
    const after = existing.slice(existing.indexOf(END) + END.length)
    updated = before + section + after
  } else {
    // Append new section (with blank line separator if file has content)
    updated = existing
      ? existing.trimEnd() + '\n\n' + section + '\n'
      : section + '\n'
  }

  writeFileSync(claudeMdPath, updated)
}

function loadOrchestratorContent(): string {
  // Look for prompts/orchestrator.md relative to dist/ or src/
  const candidates = [
    join(__dirname, '..', 'prompts', 'orchestrator.md'),
    join(__dirname, '..', '..', 'prompts', 'orchestrator.md'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf-8').trim()
  }
  // Fallback: embed minimal instructions inline
  return `# MultiClaude Orchestrator\n\nYou are a MultiClaude orchestrator. Use the multiclaude-coord MCP tools to plan, spawn, and monitor worker agents.`
}
```

**Step 4: Run tests**

```bash
cd /Users/marcus/Developer/MultiClaude && npm test -- tests/init.test.ts
```

Expected: all 6 tests pass.

**Step 5: Commit**

```bash
git add src/init.ts tests/init.test.ts
git commit -m "feat: add init module with runInit and tests"
```

---

### Task 2: Add `init` subcommand to CLI and clean up `start`

**Files:**
- Modify: `src/cli.ts`

**Step 1: Write failing test (integration)**

Add to `tests/init.test.ts`:

```typescript
// Integration: runInit uses default port 7432 when no port given
it('uses default coordPort 7432', () => {
  runInit({ projectDir: testDir })
  const settings = JSON.parse(
    readFileSync(join(testDir, '.claude', 'settings.local.json'), 'utf-8')
  )
  expect(settings.mcpServers['multiclaude-coord'].url).toBe(
    'http://localhost:7432/orchestrator'
  )
})
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/marcus/Developer/MultiClaude && npm test -- tests/init.test.ts
```

Expected: PASS (this actually tests `runInit` which already handles missing port). The test should pass.

**Step 3: Update `src/cli.ts`**

Replace the entire `main()` function:

1. Parse subcommand: `args[0]` is `'init'` or `'start'` (default when undefined or a flag)
2. For `init`:
   - Parse `--coord-port=N` (default 7432)
   - Call `runInit({ coordPort, projectDir: process.cwd() })`
   - Exit
3. For `start`:
   - Keep existing logic
   - **Remove** the session-directory hack (lines 113–122 and 124–125)
   - **Replace** the final `console.log` block with:
     ```
     MultiClaude running!
       Coord:      http://localhost:${port}
       Dashboard:  http://localhost:${webPort}

     Connect a project:  multiclaude init   (run from your project directory)
     Then just run:      claude
     ```

The diff to `src/cli.ts`:

```typescript
// Add import at top:
import { runInit } from './init.js'

// Replace main() body:
async function main() {
  const args = process.argv.slice(2)
  const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : 'start'

  if (subcommand === 'init') {
    const coordPortArg = args.find(a => a.startsWith('--coord-port='))
    const coordPort = coordPortArg ? parseInt(coordPortArg.split('=')[1]) : 7432
    runInit({ coordPort, projectDir: process.cwd() })
    return
  }

  // --- start (default) ---
  const noTui = args.includes('--no-tui')
  const noWeb = args.includes('--no-web')
  const coordPortArg = args.find(a => a.startsWith('--coord-port='))
  const webPortArg = args.find(a => a.startsWith('--web-port='))
  const coordPort = coordPortArg ? parseInt(coordPortArg.split('=')[1]) : 7432
  const webPort = webPortArg ? parseInt(webPortArg.split('=')[1]) : 7433

  const reset = args.includes('--reset')
  if (reset) {
    const dbPath = join(process.cwd(), 'multiclaude.db')
    for (const f of [dbPath, dbPath + '-shm', dbPath + '-wal']) {
      if (existsSync(f)) rmSync(f)
    }
    console.log('Database reset.')
  }

  console.log('Starting MultiClaude...')

  const { db, port } = await startCoordServer({ port: coordPort })
  console.log(`Coordination server: http://localhost:${port}`)

  const mcpConfigPath = writeWorkerMcpConfig(port)
  startSpawnerWatcher(db, mcpConfigPath)

  if (!noWeb) {
    startWebServer(db, webPort)
    console.log(`Web dashboard: http://localhost:${webPort}`)
  }

  console.log(`\nMultiClaude running!`)
  console.log(`  Connect a project: multiclaude init   (run from your project directory)`)
  console.log(`  Then just run:     claude`)
  console.log(`\nNote: ports ${coordPort} (coord) and ${webPort} (web) are reserved.\n`)

  if (!noTui) {
    startTui(db)
  } else {
    console.log('Press Ctrl+C to stop.')
  }
}
```

Also remove the now-unused imports: `readFileSync`, `fileURLToPath`, `dirname`, `__dirname`.

**Step 4: Run all tests**

```bash
cd /Users/marcus/Developer/MultiClaude && npm test
```

Expected: all tests pass.

**Step 5: Quick smoke test**

```bash
cd /Users/marcus/Developer/TestMultiClaude && node /Users/marcus/Developer/MultiClaude/dist/cli.js init 2>&1 || tsx /Users/marcus/Developer/MultiClaude/src/cli.ts init
```

Expected: prints confirmation, `.claude/settings.local.json` updated, `CLAUDE.md` updated.

**Step 6: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add init subcommand, remove session-dir hack from start"
```

---

### Task 3: Verify end-to-end

**Step 1: Run all tests one final time**

```bash
cd /Users/marcus/Developer/MultiClaude && npm test
```

Expected: all tests pass, no regressions.

**Step 2: Check generated files in TestMultiClaude**

```bash
cat /Users/marcus/Developer/TestMultiClaude/.claude/settings.local.json
cat /Users/marcus/Developer/TestMultiClaude/CLAUDE.md | head -30
```

Expected:
- `settings.local.json` has `mcpServers.multiclaude-coord` pointing to `http://localhost:7432/orchestrator`
- `CLAUDE.md` has `<!-- multiclaude:start -->` section

**Step 3: Commit any final cleanup**

If no changes needed: done.
