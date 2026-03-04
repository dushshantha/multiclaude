"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Badge,
} from "@tremor/react";

export interface SessionRow {
  id: string;
  gitBranch: string | null;
  costUsd: string;
  startedAt: string;
  outcomeType: string | null;
  prUrl: string | null;
}

function OutcomeCell({
  type,
  prUrl,
}: {
  type: string | null;
  prUrl: string | null;
}) {
  if (!type || type === "none") {
    return <Badge color="gray">none</Badge>;
  }
  if (type === "pr" && prUrl) {
    return (
      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 hover:underline"
      >
        <Badge color="green">PR</Badge>
      </a>
    );
  }
  if (type === "pr") {
    return <Badge color="green">PR</Badge>;
  }
  if (type === "ticket") {
    return <Badge color="blue">ticket</Badge>;
  }
  if (type === "commit") {
    return <Badge color="indigo">commit</Badge>;
  }
  return <Badge color="gray">{type}</Badge>;
}

export function SessionTable({ sessions }: { sessions: SessionRow[] }) {
  if (sessions.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-gray-500">
        No sessions yet.
      </div>
    );
  }

  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeaderCell>Branch</TableHeaderCell>
          <TableHeaderCell>Cost</TableHeaderCell>
          <TableHeaderCell>Date</TableHeaderCell>
          <TableHeaderCell>Outcome</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {sessions.map((s) => (
          <TableRow key={s.id}>
            <TableCell className="font-mono text-xs">
              {s.gitBranch ?? "—"}
            </TableCell>
            <TableCell>${parseFloat(s.costUsd).toFixed(4)}</TableCell>
            <TableCell>
              {new Date(s.startedAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </TableCell>
            <TableCell>
              <OutcomeCell type={s.outcomeType} prUrl={s.prUrl} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
