import { sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'

export interface OrgMetrics {
  costPerPr: number
  costPerTicket: number
  waste: number
}

export async function getOrgMetrics(db: Db, orgId: string): Promise<OrgMetrics> {
  const [prResult, ticketResult, wasteResult] = await Promise.all([
    db.execute<{ cost_per_pr: string | null; pr_count: string }>(sql`
      SELECT
        COUNT(DISTINCT o.id)::text AS pr_count,
        CASE WHEN COUNT(DISTINCT o.id) > 0
          THEN (SUM(s.cost_usd) / COUNT(DISTINCT o.id))::text
          ELSE '0'
        END AS cost_per_pr
      FROM sessions s
      JOIN outcomes o ON o.session_id = s.id
      WHERE s.org_id = ${orgId}
        AND o.type = 'pr'
    `),
    db.execute<{ cost_per_ticket: string | null; ticket_count: string }>(sql`
      SELECT
        COUNT(DISTINCT o.id)::text AS ticket_count,
        CASE WHEN COUNT(DISTINCT o.id) > 0
          THEN (SUM(s.cost_usd) / COUNT(DISTINCT o.id))::text
          ELSE '0'
        END AS cost_per_ticket
      FROM sessions s
      JOIN outcomes o ON o.session_id = s.id
      WHERE s.org_id = ${orgId}
        AND o.type = 'ticket'
    `),
    db.execute<{ total_waste: string }>(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total_waste
      FROM waste_sessions
      WHERE org_id = ${orgId}
    `),
  ])

  return {
    costPerPr: parseFloat(prResult.rows[0]?.cost_per_pr ?? '0'),
    costPerTicket: parseFloat(ticketResult.rows[0]?.cost_per_ticket ?? '0'),
    waste: parseFloat(wasteResult.rows[0]?.total_waste ?? '0'),
  }
}
