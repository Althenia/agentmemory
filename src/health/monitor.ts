import type { ISdk } from "iii-sdk";
import type { HealthSnapshot } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { evaluateHealth } from "./thresholds.js";

const RSS_BUDGET_BYTES = 512 * 1024 * 1024;

type RssBudgetResult = Pick<HealthSnapshot, "status" | "alerts">;

export function createRssBudgetTracker(
  collectGarbage: (() => void) | undefined = global.gc,
): (rss: number) => RssBudgetResult {
  let breaches = 0;
  let postGcBreaches = 0;
  let gcRequested = false;

  return (rss) => {
    if (rss <= RSS_BUDGET_BYTES) {
      breaches = 0;
      postGcBreaches = 0;
      gcRequested = false;
      return { status: "healthy", alerts: [] };
    }

    breaches++;
    if (breaches === 1) return { status: "healthy", alerts: [] };

    if (!gcRequested) {
      gcRequested = true;
      if (collectGarbage) {
        collectGarbage();
        return {
          status: "degraded",
          alerts: ["rss_warn_512mb", "rss_gc_attempted_512mb"],
        };
      }
      return {
        status: "degraded",
        alerts: ["rss_warn_512mb", "rss_gc_unavailable_512mb"],
      };
    }

    postGcBreaches++;
    return postGcBreaches >= 3
      ? { status: "critical", alerts: ["rss_critical_512mb"] }
      : { status: "degraded", alerts: ["rss_warn_512mb"] };
  };
}

export function registerHealthMonitor(
  sdk: ISdk,
  kv: StateKV,
): { stop: () => void } {
  let connectionState = "connected";
  let prevCpuUsage = process.cpuUsage();
  let prevCpuTime = Date.now();
  const evaluateRssBudget = createRssBudgetTracker();

  if (typeof sdk.on === "function") {
    sdk.on("connection_state", (state?: unknown) => {
      connectionState = state as string;
    });
  }

  async function collectHealth(): Promise<HealthSnapshot> {
    const mem = process.memoryUsage();
    const currentCpu = process.cpuUsage();
    const now = Date.now();
    const uptime = process.uptime();

    const elapsedMs = now - prevCpuTime;
    const userDelta = currentCpu.user - prevCpuUsage.user;
    const systemDelta = currentCpu.system - prevCpuUsage.system;
    const cpuPercent =
      elapsedMs > 0 ? ((userDelta + systemDelta) / 1000 / elapsedMs) * 100 : 0;
    prevCpuUsage = currentCpu;
    prevCpuTime = now;

    const startMark = performance.now();
    await new Promise((resolve) => setImmediate(resolve));
    const eventLoopLagMs = performance.now() - startMark;

    let workers: HealthSnapshot["workers"] = [];
    try {
      const result = await sdk.trigger<
        unknown,
        { workers?: HealthSnapshot["workers"] }
      >({ function_id: "engine::workers::list", payload: {} });
      if (result?.workers) workers = result.workers;
    } catch {}

    const KV_PROBE_TIMEOUT = 5000;
    let kvConnectivity: { status: string; latencyMs?: number; error?: string };
    const kvStart = performance.now();
    try {
      await Promise.race([
        (async () => {
          await kv.set(KV.health, "_probe", { ts: Date.now() });
          await kv.get(KV.health, "_probe");
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), KV_PROBE_TIMEOUT),
        ),
      ]);
      kvConnectivity = { status: "ok", latencyMs: Math.round((performance.now() - kvStart) * 100) / 100 };
    } catch {
      kvConnectivity = { status: "error", error: "kv_probe_failed", latencyMs: Math.round((performance.now() - kvStart) * 100) / 100 };
    }

    const snapshot: HealthSnapshot = {
      connectionState,
      workers,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
      },
      cpu: {
        userMicros: currentCpu.user,
        systemMicros: currentCpu.system,
        percent: Math.round(cpuPercent * 100) / 100,
      },
      eventLoopLagMs,
      uptimeSeconds: uptime,
      kvConnectivity,
      status: "healthy",
      alerts: [],
    };

    const evaluated = evaluateHealth(snapshot);
    snapshot.status = evaluated.status;
    snapshot.alerts = evaluated.alerts;
    snapshot.notes = evaluated.notes;
    const rssBudget = evaluateRssBudget(snapshot.memory.rss);
    snapshot.alerts.push(...rssBudget.alerts);
    if (
      rssBudget.status === "critical" ||
      (rssBudget.status === "degraded" && snapshot.status === "healthy")
    ) {
      snapshot.status = rssBudget.status;
    }

    await kv.set(KV.health, "latest", snapshot).catch(() => {});
    return snapshot;
  }

  collectHealth().catch(() => {});
  const interval = setInterval(() => {
    collectHealth().catch(() => {});
  }, 30_000);
  interval.unref();

  return {
    stop: () => clearInterval(interval),
  };
}

export async function getLatestHealth(
  kv: StateKV,
): Promise<HealthSnapshot | null> {
  return kv.get<HealthSnapshot>(KV.health, "latest");
}
