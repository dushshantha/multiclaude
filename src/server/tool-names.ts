/**
 * Single source of truth for orchestrator MCP tool names.
 * Both the server registration (src/server/index.ts) and the init
 * permissions list (src/init.ts) derive from this constant so they
 * can never drift apart.
 */
export const ORCHESTRATOR_TOOL_NAMES = [
  'plan_dag',
  'get_system_status',
  'wait_for_event',
  'spawn_worker',
  'cancel_task',
  'complete_task',
  'recover_task',
  'create_run',
  'list_projects',
  'list_runs',
  'git_status',
  'push_run_branch',
  'create_pr',
  'resolve_merge_conflict',
] as const

export type OrchestratorToolName = typeof ORCHESTRATOR_TOOL_NAMES[number]
