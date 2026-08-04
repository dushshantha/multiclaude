// Clear git isolation env vars set by the worker agent environment.
// Tests that create temp git repos use execSync without an explicit env
// object, so they inherit process.env. If GIT_DIR/GIT_WORK_TREE are set
// (as they are when running inside a MultiClaude worktree), git commands
// target the parent repo instead of the test's temp repo.
// Tests that need specific git env vars set up their own env objects and
// pass them explicitly to execSync.
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE
delete process.env.GIT_CEILING_DIRECTORIES
