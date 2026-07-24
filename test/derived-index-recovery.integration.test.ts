import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWorker, type ISdk } from "iii-sdk";
import { recoverDerivedIndexLifecycle } from "../src/state/graph-derived-index.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";

const engineUrl = process.env["AGENTMEMORY_REAL_ENGINE_URL"];
const runRealEngine = engineUrl !== undefined;

describe.runIf(runRealEngine)("derived-index recovery with an isolated real engine", () => {
  let sdk: ISdk;
  let kv: StateKV;
  const markerToken = `integration-${randomUUID()}`;

  beforeAll(async () => {
    sdk = registerWorker(engineUrl!, {
      workerName: `agentmemory-recovery-integration-${randomUUID()}`,
      invocationTimeoutMs: 10_000,
    });
    kv = new StateKV(sdk);
    const existing = await kv.get(KV.graphDerivedMetadata, "maintenance");
    if (existing !== null) {
      throw new Error("real-engine integration requires an isolated lifecycle scope");
    }
  });

  afterAll(async () => {
    const current = await kv.get<{ ownerToken?: string }>(
      KV.graphDerivedMetadata,
      "maintenance",
    ).catch(() => null);
    if (current?.ownerToken === markerToken) {
      await kv.delete(KV.graphDerivedMetadata, "maintenance").catch(() => undefined);
    }
    await sdk.shutdown();
  });

  it("removes an old marker without inflight tokens or durable-data deletion", async () => {
    const generation = `integration-${randomUUID()}`;
    const generationKey = `generation:${generation}`;
    const durableMetadata = { integrationEvidence: markerToken };
    await kv.set(KV.graphDerivedMetadata, generationKey, durableMetadata);
    await kv.set(KV.graphDerivedMetadata, "maintenance", {
      version: 2,
      operation: "rebuild",
      generation,
      ownerToken: markerToken,
      startedAt: "2000-01-01T00:00:00.000Z",
    });

    try {
      await expect(recoverDerivedIndexLifecycle(kv, {
        minimumAgeSeconds: 60,
        expectedMarkerToken: markerToken,
      })).resolves.toEqual({
        recoveredInflight: 0,
        removedMaintenance: true,
      });
      expect(
        await kv.get(KV.graphDerivedMetadata, "maintenance"),
      ).toBeNull();
      expect(
        await kv.get(KV.graphDerivedMetadata, generationKey),
      ).toEqual(durableMetadata);
    } finally {
      await kv.delete(KV.graphDerivedMetadata, generationKey);
    }
  });
});
