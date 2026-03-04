import { currentUser } from "@clerk/nextjs/server";
import { Card, Metric, Text, Title } from "@tremor/react";
import { SessionTable, type SessionRow } from "../../components/SessionTable";

const API_URL = process.env.API_URL ?? "http://localhost:3001";

interface ApiSession {
  id: string;
  developerId: string | null;
  gitBranch: string | null;
  costUsd: string;
  startedAt: string;
  outcomes?: Array<{
    type: string;
    prUrl: string | null;
  }>;
}

async function fetchDeveloperSessions(
  developerEmail: string | null
): Promise<SessionRow[]> {
  if (!developerEmail) return [];

  try {
    // Fetch sessions scoped to this developer via the API
    const url = new URL("/me/sessions", API_URL);
    url.searchParams.set("email", developerEmail);

    const res = await fetch(url.toString(), {
      next: { revalidate: 60 },
    });

    if (!res.ok) return [];

    const data: ApiSession[] = await res.json();
    return data.map((s) => {
      const outcome = s.outcomes?.[0] ?? null;
      return {
        id: s.id,
        gitBranch: s.gitBranch,
        costUsd: s.costUsd,
        startedAt: s.startedAt,
        outcomeType: outcome?.type ?? null,
        prUrl: outcome?.prUrl ?? null,
      };
    });
  } catch {
    return [];
  }
}

function calcStats(sessions: SessionRow[]) {
  const totalSpend = sessions.reduce(
    (sum, s) => sum + parseFloat(s.costUsd),
    0
  );
  const prCount = sessions.filter((s) => s.outcomeType === "pr").length;
  return { totalSpend, prCount };
}

export default async function MePage() {
  const user = await currentUser();
  const email =
    user?.emailAddresses?.[0]?.emailAddress ?? null;

  const sessions = await fetchDeveloperSessions(email);
  const { totalSpend, prCount } = calcStats(sessions);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-8">
        <Title>My Activity</Title>
        <Text className="mt-1 text-gray-500">
          {user?.firstName
            ? `Welcome back, ${user.firstName}.`
            : "Your session history and spend summary."}
        </Text>
      </div>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <Text>Total Spend</Text>
          <Metric>${totalSpend.toFixed(4)}</Metric>
        </Card>
        <Card>
          <Text>PRs Opened</Text>
          <Metric>{prCount}</Metric>
        </Card>
      </div>

      <Card>
        <Title className="mb-4">Session History</Title>
        <SessionTable sessions={sessions} />
      </Card>
    </main>
  );
}
