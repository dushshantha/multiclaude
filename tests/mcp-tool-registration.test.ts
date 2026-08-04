import { describe, it, expect } from 'vitest'
import { createDb, closeDb } from '../src/server/state/db.js'
import { createOrchestratorMcp, createWorkerMcp } from '../src/server/index.js'

const GIT_TOOLS = ['git_status', 'push_run_branch', 'create_pr', 'resolve_merge_conflict']

function registeredToolNames(server: ReturnType<typeof createOrchestratorMcp>): string[] {
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)
}

describe('MCP tool registration', () => {
  it('git tools are present on the orchestrator server', () => {
    const db = createDb(':memory:')
    try {
      const server = createOrchestratorMcp(db)
      const names = registeredToolNames(server)
      for (const name of GIT_TOOLS) {
        expect(names, `Expected ${name} to be registered on orchestrator`).toContain(name)
      }
    } finally {
      closeDb(db)
    }
  })

  it('git tools are absent from the worker server', () => {
    const db = createDb(':memory:')
    try {
      const server = createWorkerMcp(db)
      const names = registeredToolNames(server)
      for (const name of GIT_TOOLS) {
        expect(names, `Expected ${name} to be absent from worker`).not.toContain(name)
      }
    } finally {
      closeDb(db)
    }
  })

  it('orchestrator has all expected baseline tools', () => {
    const db = createDb(':memory:')
    try {
      const server = createOrchestratorMcp(db)
      const names = registeredToolNames(server)
      const baseline = ['plan_dag', 'spawn_worker', 'get_system_status', 'wait_for_event', 'cancel_task', 'complete_task', 'recover_task', 'create_run', 'list_projects', 'list_runs']
      for (const name of baseline) {
        expect(names, `Expected ${name} to be registered on orchestrator`).toContain(name)
      }
    } finally {
      closeDb(db)
    }
  })

  it('worker has expected worker-scoped tools', () => {
    const db = createDb(':memory:')
    try {
      const server = createWorkerMcp(db)
      const names = registeredToolNames(server)
      const expected = ['get_my_task', 'report_progress', 'report_done', 'report_blocked']
      for (const name of expected) {
        expect(names, `Expected ${name} to be registered on worker`).toContain(name)
      }
    } finally {
      closeDb(db)
    }
  })
})
