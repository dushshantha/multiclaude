/**
 * Tests for tmux window reaping on terminal task states:
 * - done (via report_done)
 * - cancelled (via cancel_task)
 * - timed out (via stuck-watcher)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockKillTmuxWindow } = vi.hoisted(() => ({
  mockKillTmuxWindow: vi.fn(),
}))

vi.mock('../../src/spawner/tmux.js', () => ({
  killTmuxWindow: mockKillTmuxWindow,
  captureTmuxPane: vi.fn(() => ''),
  spawnTmuxWorker: vi.fn(),
  ensureTmuxSession: vi.fn(() => 'multiclaude'),
  createTmuxWindow: vi.fn(() => '@1'),
  getTmuxPanePid: vi.fn(() => undefined),
  sendTmuxKeys: vi.fn(),
  writeLaunchScript: vi.fn(() => '/tmp/worker-launch.sh'),
  sendToPane: vi.fn(() => ({ sent: true, enterRetries: 0 })),
  capturePaneText: vi.fn(() => ''),
  classifyComposerState: vi.fn(() => 'empty'),
  isPaneBusy: vi.fn(() => false),
}))

import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask, updateTask } from '../../src/server/state/tasks.js'
import { registerAgent, updateAgent } from '../../src/server/state/agents.js'
import { handleReportDone } from '../../src/server/tools/worker.js'
import { handleCancelTask } from '../../src/server/tools/orchestrator.js'
import { checkStuckWorkers } from '../../src/spawner/stuck-watcher.js'
import type Database from 'better-sqlite3'

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

describe('tmux window reaping on terminal states', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    mockKillTmuxWindow.mockReset()
  })

  afterEach(() => {
    closeDb(db)
  })

  describe('report_done', () => {
    it('kills the tmux window when task completes successfully', async () => {
      createTask(db, { id: 't1', title: 'Test task' })
      updateTask(db, 't1', { status: 'in_progress', agent_id: 'w-t1' })
      registerAgent(db, { id: 'w-t1', task_id: 't1' })
      updateAgent(db, 'w-t1', { tmux_pane: '@42' })

      await handleReportDone(db, 't1', 'Done')

      expect(mockKillTmuxWindow).toHaveBeenCalledWith('@42')
    })

    it('does not call killTmuxWindow when agent has no tmux_pane', async () => {
      createTask(db, { id: 't1', title: 'Test task' })
      updateTask(db, 't1', { status: 'in_progress', agent_id: 'w-t1' })
      registerAgent(db, { id: 'w-t1', task_id: 't1' })
      // No tmux_pane set

      await handleReportDone(db, 't1', 'Done')

      expect(mockKillTmuxWindow).not.toHaveBeenCalled()
    })

    it('does not call killTmuxWindow when task has no agent_id', async () => {
      createTask(db, { id: 't1', title: 'Test task' })
      updateTask(db, 't1', { status: 'in_progress' })

      await handleReportDone(db, 't1', 'Done')

      expect(mockKillTmuxWindow).not.toHaveBeenCalled()
    })
  })

  describe('cancel_task', () => {
    it('kills the tmux window when task is cancelled and agent has a pane', () => {
      createTask(db, { id: 't1', title: 'Test task' })
      updateTask(db, 't1', { status: 'in_progress', agent_id: 'w-t1' })
      registerAgent(db, { id: 'w-t1', task_id: 't1' })
      updateAgent(db, 'w-t1', { tmux_pane: '@7' })

      handleCancelTask(db, 't1')

      expect(mockKillTmuxWindow).toHaveBeenCalledWith('@7')
    })

    it('does not call killTmuxWindow when task has no agent', () => {
      createTask(db, { id: 't1', title: 'Test task' })

      handleCancelTask(db, 't1')

      expect(mockKillTmuxWindow).not.toHaveBeenCalled()
    })

    it('does not call killTmuxWindow when agent has no tmux_pane', () => {
      createTask(db, { id: 't1', title: 'Test task' })
      updateTask(db, 't1', { status: 'in_progress', agent_id: 'w-t1' })
      registerAgent(db, { id: 'w-t1', task_id: 't1' })

      handleCancelTask(db, 't1')

      expect(mockKillTmuxWindow).not.toHaveBeenCalled()
    })
  })

  describe('stuck-watcher timeout', () => {
    it('kills the tmux window when a task times out', () => {
      db.prepare(
        "INSERT INTO tasks (id, title, status, started_at) VALUES ('t1', 'T', 'in_progress', ?)"
      ).run(minutesAgo(15))
      db.prepare("INSERT INTO agents (id, task_id, status, tmux_pane) VALUES ('a1', 't1', 'running', '@99')").run()
      db.prepare(
        "INSERT INTO logs (task_id, level, message, created_at) VALUES ('t1', 'info', 'old', ?)"
      ).run(minutesAgo(15))

      const stuckSince = new Map<string, number>()
      const mockCapture = () => 'idle'
      checkStuckWorkers(db, stuckSince, 5, 10, Date.now(), mockCapture, mockKillTmuxWindow)

      expect(mockKillTmuxWindow).toHaveBeenCalledWith('@99')
    })
  })
})
