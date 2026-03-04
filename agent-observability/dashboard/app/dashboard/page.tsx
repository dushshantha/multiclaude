import { currentUser } from "@clerk/nextjs/server";
import { RoiPanel } from "../../components/RoiPanel";
import { WastePanel } from "../../components/WastePanel";

const API_BASE = process.env.ANALYTICS_API_URL ?? "http://localhost:3001";
const DEFAULT_ORG_ID = process.env.ORG_ID ?? "default";

interface OrgMetrics {
  costPerPr: number;
  costPerTicket: number;
  waste: number;
}

async function fetchMetrics(orgId: string): Promise<OrgMetrics> {
  const res = await fetch(`${API_BASE}/orgs/${orgId}/metrics`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch metrics: ${res.status}`);
  }
  return res.json();
}

export default async function DashboardPage() {
  const user = await currentUser();
  let metrics: OrgMetrics = { costPerPr: 0, costPerTicket: 0, waste: 0 };
  let error: string | null = null;

  try {
    metrics = await fetchMetrics(DEFAULT_ORG_ID);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load metrics";
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-2 text-3xl font-bold text-gray-900">
          Director Dashboard
        </h1>
        <p className="mb-8 text-gray-500">
          {user?.firstName
            ? `Welcome, ${user.firstName}. ROI and waste overview for your AI development spend.`
            : "ROI and waste overview for your AI development spend."}
        </p>

        {error && (
          <div className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <section className="mb-8">
          <h2 className="mb-4 text-xl font-semibold text-gray-700">
            Return on Investment
          </h2>
          <RoiPanel
            costPerPr={metrics.costPerPr}
            costPerTicket={metrics.costPerTicket}
          />
        </section>

        <section>
          <h2 className="mb-4 text-xl font-semibold text-gray-700">
            Waste Analysis
          </h2>
          <WastePanel totalWaste={metrics.waste} />
        </section>
      </div>
    </div>
  );
}
