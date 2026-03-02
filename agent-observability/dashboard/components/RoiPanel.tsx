"use client";

import { Card, Metric, Text, Flex, BadgeDelta } from "@tremor/react";

interface RoiPanelProps {
  costPerPr: number;
  costPerTicket: number;
}

export function RoiPanel({ costPerPr, costPerTicket }: RoiPanelProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Card>
        <Text>Cost per PR</Text>
        <Flex alignItems="end" className="gap-2">
          <Metric>${costPerPr.toFixed(2)}</Metric>
          <BadgeDelta deltaType="moderateDecrease">vs last month</BadgeDelta>
        </Flex>
      </Card>
      <Card>
        <Text>Cost per Ticket</Text>
        <Flex alignItems="end" className="gap-2">
          <Metric>${costPerTicket.toFixed(2)}</Metric>
          <BadgeDelta deltaType="moderateDecrease">vs last month</BadgeDelta>
        </Flex>
      </Card>
    </div>
  );
}
