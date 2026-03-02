"use client";

import {
  Card,
  Metric,
  Text,
  Flex,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Badge,
} from "@tremor/react";

const REASON_LABELS: Record<string, string> = {
  no_outcome_48h: "No outcome after 48h",
  duplicate_session: "Duplicate session",
  abandoned: "Abandoned",
};

interface WasteSession {
  sessionId: string;
  reason: string;
  costUsd: number;
  flaggedAt: string;
}

interface WastePanelProps {
  totalWaste: number;
  wasteSessions?: WasteSession[];
}

export function WastePanel({ totalWaste, wasteSessions = [] }: WastePanelProps) {
  return (
    <Card>
      <Flex alignItems="start" justifyContent="between">
        <div>
          <Text>Total Waste Cost</Text>
          <Metric>${totalWaste.toFixed(2)}</Metric>
        </div>
        <Badge color={totalWaste > 10 ? "red" : totalWaste > 1 ? "yellow" : "green"}>
          {totalWaste > 10 ? "High" : totalWaste > 1 ? "Moderate" : "Low"}
        </Badge>
      </Flex>

      {wasteSessions.length > 0 && (
        <Table className="mt-4">
          <TableHead>
            <TableRow>
              <TableHeaderCell>Session</TableHeaderCell>
              <TableHeaderCell>Reason</TableHeaderCell>
              <TableHeaderCell>Cost</TableHeaderCell>
              <TableHeaderCell>Flagged At</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {wasteSessions.map((ws) => (
              <TableRow key={ws.sessionId}>
                <TableCell className="font-mono text-xs">{ws.sessionId.slice(0, 8)}…</TableCell>
                <TableCell>
                  <Badge color="orange">
                    {REASON_LABELS[ws.reason] ?? ws.reason}
                  </Badge>
                </TableCell>
                <TableCell>${ws.costUsd.toFixed(4)}</TableCell>
                <TableCell>{new Date(ws.flaggedAt).toLocaleDateString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {wasteSessions.length === 0 && (
        <Text className="mt-4 text-gray-400">No individual waste sessions available.</Text>
      )}
    </Card>
  );
}
