import { pgTable, text, uuid, timestamp, numeric, integer, unique } from 'drizzle-orm/pg-core'

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const developers = pgTable('developers', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => orgs.id),
  email: text('email').notNull(),
  name: text('name'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  uniqueOrgEmail: unique('developers_org_email_unique').on(table.orgId, table.email),
}))

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => orgs.id),
  developerId: uuid('developer_id').references(() => developers.id),
  agentType: text('agent_type').notNull().default('claude-code'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  endedAt: timestamp('ended_at'),
  durationSecs: integer('duration_secs'),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
  gitBranch: text('git_branch'),
  gitRepo: text('git_repo'),
  workingDir: text('working_dir'),
  taskDescription: text('task_description'),
})

export const outcomes = pgTable('outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id),
  orgId: uuid('org_id').notNull().references(() => orgs.id),
  type: text('type').notNull(), // 'pr' | 'ticket' | 'commit' | 'none'
  prUrl: text('pr_url'),
  linesAdded: integer('lines_added'),
  linesRemoved: integer('lines_removed'),
  reviewCycles: integer('review_cycles'),
  ticketId: text('ticket_id'),
  storyPoints: integer('story_points'),
  cycleTimeHours: numeric('cycle_time_hours', { precision: 8, scale: 2 }),
  linkedAt: timestamp('linked_at').defaultNow().notNull(),
})

export const wasteSessions = pgTable('waste_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id),
  orgId: uuid('org_id').notNull().references(() => orgs.id),
  reason: text('reason').notNull(),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull(),
  flaggedAt: timestamp('flagged_at').defaultNow().notNull(),
})

export const tokens = pgTable('tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => orgs.id),
  developerId: uuid('developer_id').references(() => developers.id),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
