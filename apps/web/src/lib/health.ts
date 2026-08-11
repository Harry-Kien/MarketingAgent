import { redact } from "@smos/telemetry";

export interface HealthDeps {
  pingDb: () => Promise<void>;
  pingQueue: () => Promise<void>;
}

export interface HealthCheck {
  name: string;
  ok: boolean;
  error?: string;
}

export interface HealthReport {
  status: "ok" | "degraded";
  checks: HealthCheck[];
}

async function probe(name: string, fn: () => Promise<void>): Promise<HealthCheck> {
  try {
    await fn();
    return { name, ok: true };
  } catch (error) {
    // Driver errors routinely embed the connection string, so the message goes
    // through redact before it can reach a response body or a log (threat T4).
    return { name, ok: false, error: String(redact(String(error))) };
  }
}

export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  // Every dependency is probed even after one fails, so a single outage does
  // not hide a second one.
  const checks = await Promise.all([
    probe("database", deps.pingDb),
    probe("queue", deps.pingQueue),
  ]);
  return { status: checks.every((c) => c.ok) ? "ok" : "degraded", checks };
}
