import { eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { sessions, outcomes } from '../db/schema.js'
import type { PrInfo } from './github.js'
import type { TicketSummary } from './jira.js'

export interface AttributionDeps {
  findPr: (repo: string, branch: string) => Promise<PrInfo | null>
  findTicket: (branch: string) => Promise<TicketSummary | null>
}

export async function runAttributionPass(
  db: Db,
  deps: AttributionDeps
): Promise<number> {
  const unattributed = await db
    .select({
      id: sessions.id,
      orgId: sessions.orgId,
      gitBranch: sessions.gitBranch,
      gitRepo: sessions.gitRepo,
    })
    .from(sessions)
    .leftJoin(outcomes, eq(outcomes.sessionId, sessions.id))
    .where(isNull(outcomes.id))

  let linked = 0
  for (const session of unattributed) {
    if (!session.gitBranch) continue

    const [pr, ticket] = await Promise.all([
      session.gitRepo
        ? deps.findPr(session.gitRepo, session.gitBranch)
        : Promise.resolve(null),
      deps.findTicket(session.gitBranch),
    ])

    if (pr || ticket) {
      await db.insert(outcomes).values({
        sessionId: session.id,
        orgId: session.orgId,
        type: pr ? 'pr' : 'ticket',
        prUrl: pr?.url ?? null,
        ticketId: ticket?.id ?? null,
        storyPoints: ticket?.storyPoints ?? null,
      })
      linked++
    }
  }

  return linked
}
