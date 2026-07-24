import { describe, expect, it, vi } from "vitest";
import * as derivedIndex from "../src/state/graph-derived-index.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, GraphNode, Session } from "../src/types.js";

interface GenerationMetadata {
  generation: string;
  status: "building" | "complete";
  totalCount: number;
  finalChecksum?: string;
  progress: Record<string, { count: number; complete: boolean; checksum: string }>;
}

interface ActiveGeneration {
  version: 2;
  generation: string;
  previousGeneration?: string;
  checksum: string;
}

interface GenerationStatus {
  active: ActiveGeneration | null;
  maintenance: {
    generation: string;
    operation: string;
    ownerToken: string;
  } | null;
  generation: GenerationMetadata | null;
  inFlight: boolean;
  inFlightMutations: Array<{
    ownerToken: string;
    operationToken: string;
    startedAt: string;
    expiresAt: string;
  }>;
  rollbackInvalidated: boolean;
}

interface RecoveryResult {
  recoveredInflight: number;
  removedMaintenance: boolean;
}

interface GenerationApi {
  beginDerivedIndexGeneration?: (
    kv: StateKV,
    options: { generation: string },
  ) => Promise<GenerationMetadata>;
  rebuildDerivedIndexGenerationPage?: (
    kv: StateKV,
    options: { generation: string; limit?: number },
  ) => Promise<{ processed: number; complete: boolean; metadata: GenerationMetadata }>;
  getDerivedIndexGenerationStatus?: (
    kv: StateKV,
    options?: { generation?: string },
  ) => Promise<GenerationStatus>;
  activateDerivedIndexGeneration?: (
    kv: StateKV,
    options: { generation: string },
  ) => Promise<ActiveGeneration>;
  rollbackDerivedIndexGeneration?: (
    kv: StateKV,
    options: { generation: string },
  ) => Promise<ActiveGeneration>;
  recoverDerivedIndexLifecycle?: (
    kv: StateKV,
    options: {
      minimumAgeSeconds: number;
      expectedOwnerToken?: string;
      expectedOperationToken?: string;
      expectedMarkerToken?: string;
    },
  ) => Promise<RecoveryResult>;
}

function generationApi(): Required<GenerationApi> {
  const api = derivedIndex as unknown as GenerationApi;
  expect(api.beginDerivedIndexGeneration).toBeTypeOf("function");
  expect(api.rebuildDerivedIndexGenerationPage).toBeTypeOf("function");
  expect(api.getDerivedIndexGenerationStatus).toBeTypeOf("function");
  expect(api.activateDerivedIndexGeneration).toBeTypeOf("function");
  expect(api.rollbackDerivedIndexGeneration).toBeTypeOf("function");
  expect(api.recoverDerivedIndexLifecycle).toBeTypeOf("function");
  return api as Required<GenerationApi>;
}

interface StateRequest {
  function_id: string;
  payload: Record<string, unknown>;
}

function createHarness() {
  const store = new Map<string, Map<string, unknown>>();
  let failNextSet: ((request: StateRequest) => boolean) | null = null;
  let blockedAfterSet: {
    predicate: (request: StateRequest) => boolean;
    reached: () => void;
    release: Promise<void>;
  } | null = null;
  let blockedRequest: {
    predicate: (request: StateRequest) => boolean;
    reached: () => void;
    release: Promise<void>;
  } | null = null;
  const scope = (name: string): Map<string, unknown> => {
    let values = store.get(name);
    if (!values) {
      values = new Map();
      store.set(name, values);
    }
    return values;
  };
  const trigger = vi.fn(async (request: StateRequest) => {
    const pendingBlock = blockedRequest;
    if (pendingBlock?.predicate(request)) {
      blockedRequest = null;
      pendingBlock.reached();
      await pendingBlock.release;
    }
    const payload = request.payload;
    const scopeName = payload.scope as string;
    const key = payload.key as string;
    if (request.function_id === "state::get") {
      return scope(scopeName).get(key) ?? null;
    }
    if (request.function_id === "state::set") {
      if (failNextSet?.(request)) {
        failNextSet = null;
        throw new Error("injected metadata set failure");
      }
      scope(scopeName).set(key, payload.value);
      const blocked = blockedAfterSet;
      if (blocked?.predicate(request)) {
        blockedAfterSet = null;
        blocked.reached();
        await blocked.release;
      }
      return payload.value;
    }
    if (request.function_id === "state::delete") {
      scope(scopeName).delete(key);
      return undefined;
    }
    if (request.function_id === "state::list-page") {
      const cursor = payload.cursor as string | undefined;
      const limit = (payload.limit as number | undefined) ?? 100;
      const entries = [...scope(scopeName).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([entryKey]) => cursor === undefined || entryKey > cursor);
      const items = entries.slice(0, limit);
      return {
        items: items.map(([itemKey, value]) => ({ key: itemKey, value })),
        ...(entries.length > limit
          ? { next_cursor: items[items.length - 1]![0] }
          : {}),
      };
    }
    throw new Error(`Unexpected function: ${request.function_id}`);
  });
  return {
    kv: new StateKV({ trigger } as never),
    store,
    trigger,
    seed: (scopeName: string, key: string, value: unknown) => {
      scope(scopeName).set(key, value);
    },
    failSetOnce: (predicate: (request: StateRequest) => boolean) => {
      failNextSet = predicate;
    },
    blockAfterSet: (predicate: (request: StateRequest) => boolean) => {
      let markReached!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const waitForRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      blockedAfterSet = {
        predicate,
        reached: markReached,
        release: waitForRelease,
      };
      return { reached, release };
    },
    blockRequest: (predicate: (request: StateRequest) => boolean) => {
      let markReached!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const waitForRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      blockedRequest = {
        predicate,
        reached: markReached,
        release: waitForRelease,
      };
      return { reached, release };
    },
  };
}

function seedCanonicalCorpus(harness: ReturnType<typeof createHarness>): void {
  const nodeA: GraphNode = {
    id: "node-a",
    type: "concept",
    name: "Auth",
    properties: {},
    sourceObservationIds: ["obs-a"],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const nodeB: GraphNode = {
    ...nodeA,
    id: "node-b",
    name: "Database",
  };
  const edge: GraphEdge = {
    id: "edge-a",
    type: "related_to",
    sourceNodeId: nodeA.id,
    targetNodeId: nodeB.id,
    sourceObservationIds: ["obs-a"],
    weight: 0.8,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const session: Session = {
    id: "session-a",
    project: "project-a",
    cwd: "/workspace",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    observationCount: 1,
    agentId: "agent-a",
  };
  harness.seed(KV.graphNodes, nodeA.id, nodeA);
  harness.seed(KV.graphNodes, nodeB.id, nodeB);
  harness.seed(KV.graphEdges, edge.id, edge);
  harness.seed(KV.memories, "memory-a", {
    id: "memory-a",
    sessionIds: [session.id],
    project: session.project,
    agentId: session.agentId,
  });
  harness.seed(KV.sessions, session.id, session);
  harness.seed(KV.observations(session.id), "obs-a", {
    id: "obs-a",
    sessionId: session.id,
    agentId: session.agentId,
  });
  harness.seed("mem:graph:index:name:legacy", "legacy-node", true);
}

async function finishGeneration(
  api: Required<GenerationApi>,
  kv: StateKV,
  generation: string,
): Promise<GenerationMetadata> {
  let metadata: GenerationMetadata | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await api.rebuildDerivedIndexGenerationPage(kv, {
      generation,
      limit: 1,
    });
    metadata = result.metadata;
    if (result.complete) return metadata;
  }
  throw new Error("generation did not complete within 20 pages");
}

async function activateGenerationPair(
  api: Required<GenerationApi>,
  harness: ReturnType<typeof createHarness>,
): Promise<void> {
  seedCanonicalCorpus(harness);
  await api.beginDerivedIndexGeneration(harness.kv, { generation: "gen-one" });
  await finishGeneration(api, harness.kv, "gen-one");
  await api.activateDerivedIndexGeneration(harness.kv, { generation: "gen-one" });
  await api.beginDerivedIndexGeneration(harness.kv, { generation: "gen-two" });
  await finishGeneration(api, harness.kv, "gen-two");
  await api.activateDerivedIndexGeneration(harness.kv, { generation: "gen-two" });
}

function inflightMutation(
  ownerToken: string,
  operationToken: string,
  overrides: Partial<Record<"startedAt" | "expiresAt", string>> = {},
): Record<string, unknown> {
  return {
    version: 2,
    ownerToken,
    operationToken,
    operation: "canonical-mutation",
    scope: KV.graphNodes,
    key: "node-recovery",
    startedAt: overrides.startedAt ?? "2000-01-01T00:00:00.000Z",
    expiresAt: overrides.expiresAt ?? "2000-01-01T00:05:00.000Z",
  };
}

describe("derived-index v2 generation lifecycle", () => {
  it("treats undefined optional lifecycle metadata as an empty healthy status", async () => {
    const api = generationApi();
    const trigger = vi.fn(async (request: StateRequest) => {
      if (request.function_id === "state::get") return undefined;
      if (request.function_id === "state::list-page") return { items: [] };
      throw new Error(`Unexpected function: ${request.function_id}`);
    });
    const kv = new StateKV({ trigger } as never);

    await expect(api.getDerivedIndexGenerationStatus(kv)).resolves.toEqual({
      active: null,
      maintenance: null,
      generation: null,
      inFlight: false,
      inFlightMutations: [],
      rollbackInvalidated: false,
    });
  });

  it("persists maintenance and rejects activation of an incomplete generation", async () => {
    const api = generationApi();
    const { kv } = createHarness();

    const metadata = await api.beginDerivedIndexGeneration(kv, {
      generation: "gen-one",
    });

    expect(metadata.status).toBe("building");
    const status = await api.getDerivedIndexGenerationStatus(kv, {
      generation: "gen-one",
    });
    expect(status.maintenance).toMatchObject({
      generation: "gen-one",
      operation: "rebuild",
    });
    await expect(
      api.activateDerivedIndexGeneration(kv, { generation: "gen-one" }),
    ).rejects.toThrow(/incomplete/i);
  });

  it("rebuilds bounded pages, activates atomically, and rolls back without deletion", async () => {
    const api = generationApi();
    const harness = createHarness();
    seedCanonicalCorpus(harness);
    await api.beginDerivedIndexGeneration(harness.kv, { generation: "gen-one" });

    const first = await api.rebuildDerivedIndexGenerationPage(harness.kv, {
      generation: "gen-one",
      limit: 1,
    });
    expect(first.processed).toBe(1);
    expect(first.metadata.progress["graph-nodes"]?.count).toBe(1);
    const completeOne = await finishGeneration(api, harness.kv, "gen-one");
    expect(completeOne.status).toBe("complete");
    expect(completeOne.totalCount).toBe(5);
    expect(completeOne.finalChecksum).toMatch(/^[a-f0-9]{64}$/);
    for (const segment of [
      ":name:",
      ":exact-name:",
      ":node-edges:",
      ":observation-nodes:",
      ":support-locators",
    ]) {
      expect(
        [...harness.store.keys()].some(
          (scopeName) =>
            scopeName.startsWith("mem:graph:index:v2:gen-one:") &&
            scopeName.includes(segment),
        ),
      ).toBe(true);
    }

    const activeOne = await api.activateDerivedIndexGeneration(harness.kv, {
      generation: "gen-one",
    });
    expect(activeOne).toMatchObject({ generation: "gen-one", version: 2 });

    await api.beginDerivedIndexGeneration(harness.kv, { generation: "gen-two" });
    await finishGeneration(api, harness.kv, "gen-two");
    const activeTwo = await api.activateDerivedIndexGeneration(harness.kv, {
      generation: "gen-two",
    });
    expect(activeTwo).toMatchObject({
      generation: "gen-two",
      previousGeneration: "gen-one",
    });

    const rolledBack = await api.rollbackDerivedIndexGeneration(harness.kv, {
      generation: "gen-one",
    });
    expect(rolledBack).toMatchObject({
      generation: "gen-one",
      previousGeneration: "gen-two",
    });
    expect(
      [...harness.store.keys()].some((scopeName) => scopeName.includes("gen-two")),
    ).toBe(true);
    expect(
      harness.store.get("mem:graph:index:name:legacy")?.has("legacy-node"),
    ).toBe(true);
    expect(harness.store.get(KV.graphNodes)?.size).toBe(2);
    expect(harness.store.get(KV.graphEdges)?.size).toBe(1);
  });

  it("retries a page idempotently when metadata persistence fails", async () => {
    const api = generationApi();
    const harness = createHarness();
    seedCanonicalCorpus(harness);
    await api.beginDerivedIndexGeneration(harness.kv, { generation: "gen-retry" });
    harness.failSetOnce(
      (request) =>
        request.function_id === "state::set" &&
        request.payload.scope === "mem:graph:index:v2:metadata" &&
        request.payload.key === "generation:gen-retry",
    );

    await expect(
      api.rebuildDerivedIndexGenerationPage(harness.kv, {
        generation: "gen-retry",
        limit: 1,
      }),
    ).rejects.toThrow("injected metadata set failure");
    const beforeRetry = await api.getDerivedIndexGenerationStatus(harness.kv, {
      generation: "gen-retry",
    });
    expect(beforeRetry.generation?.progress["graph-nodes"]?.count).toBe(0);

    const retry = await api.rebuildDerivedIndexGenerationPage(harness.kv, {
      generation: "gen-retry",
      limit: 1,
    });
    expect(retry.metadata.progress["graph-nodes"]?.count).toBe(1);
  });

  it("returns before 180 seconds without advancing resumable progress when page work stalls", async () => {
    vi.useFakeTimers();
    const api = generationApi();
    const harness = createHarness();
    seedCanonicalCorpus(harness);
    await api.beginDerivedIndexGeneration(harness.kv, { generation: "gen-deadline" });
    const blocked = harness.blockRequest(
      (request) => request.function_id === "state::list-page" &&
        request.payload.scope === KV.graphNodes,
    );
    const page = api.rebuildDerivedIndexGenerationPage(harness.kv, {
      generation: "gen-deadline",
      limit: 1,
    });
    await blocked.reached;
    let outcome: unknown;
    void page.then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(179_999);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/page.*budget/i);
      const metadata = harness.store.get(KV.graphDerivedMetadata)?.get(
        "generation:gen-deadline",
      ) as GenerationMetadata;
      expect(metadata.progress["graph-nodes"]).toMatchObject({
        count: 0,
        checksum: expect.any(String),
        complete: false,
      });
    } finally {
      blocked.release();
      await page.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("blocks activation while a pre-maintenance canonical mutation is in flight", async () => {
    const api = generationApi();
    const harness = createHarness();
    seedCanonicalCorpus(harness);
    await api.beginDerivedIndexGeneration(harness.kv, { generation: "gen-next" });
    await finishGeneration(api, harness.kv, "gen-next");

    // Temporarily clear maintenance to let a writer enter, then re-arm it
    // before activation. The persisted in-flight row must block the switch.
    harness.store.get("mem:graph:index:v2:metadata")?.delete("maintenance");
    const blocked = harness.blockAfterSet(
      (request) =>
        request.function_id === "state::set" &&
        request.payload.scope === "mem:graph:index:v2:inflight",
    );
    const writer = harness.kv.set(KV.graphNodes, "node-inflight", {
      id: "node-inflight",
      type: "concept",
      name: "In Flight",
      properties: {},
      sourceObservationIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies GraphNode);
    await blocked.reached;
    const registeredMutation = [
      ...(harness.store.get(KV.graphDerivedInflight)?.values() ?? []),
    ][0] as Record<string, unknown>;
    expect(registeredMutation).toMatchObject({
      version: 2,
      operation: "canonical-mutation",
      ownerToken: expect.any(String),
      operationToken: expect.any(String),
      startedAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect(Date.parse(registeredMutation.expiresAt as string)).toBeGreaterThan(
      Date.parse(registeredMutation.startedAt as string),
    );
    harness.seed("mem:graph:index:v2:metadata", "maintenance", {
      version: 2,
      operation: "rebuild",
      generation: "gen-next",
      ownerToken: "test-rebuild-owner",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      api.activateDerivedIndexGeneration(harness.kv, { generation: "gen-next" }),
    ).rejects.toThrow(/in-flight/i);
    blocked.release();
    await expect(writer).rejects.toThrow(/maintenance/i);
    expect(await harness.kv.get(KV.graphNodes, "node-inflight")).toBeNull();

    const activated = await api.activateDerivedIndexGeneration(harness.kv, {
      generation: "gen-next",
    });
    expect(activated.generation).toBe("gen-next");
  });

  it("serializes concurrent rollback then begin operations", async () => {
    const api = generationApi();
    const harness = createHarness();
    await activateGenerationPair(api, harness);
    const blocked = harness.blockAfterSet(
      (request) =>
        request.function_id === "state::set" &&
        request.payload.scope === KV.graphDerivedMetadata &&
        request.payload.key === "maintenance" &&
        (request.payload.value as { operation?: string }).operation === "rollback",
    );

    const rollback = api.rollbackDerivedIndexGeneration(harness.kv, {
      generation: "gen-one",
    });
    await blocked.reached;
    const begin = api.beginDerivedIndexGeneration(harness.kv, {
      generation: "gen-three",
    });
    const concurrent = Promise.all([rollback, begin]);
    blocked.release();

    await expect(concurrent).resolves.toEqual([
      expect.objectContaining({ generation: "gen-one" }),
      expect.objectContaining({ generation: "gen-three" }),
    ]);
    const status = await api.getDerivedIndexGenerationStatus(harness.kv, {
      generation: "gen-three",
    });
    expect(status.active?.generation).toBe("gen-one");
    expect(status.maintenance).toMatchObject({
      generation: "gen-three",
      operation: "rebuild",
      ownerToken: expect.any(String),
    });
  });

  it("serializes concurrent rollback operations to one active-pointer write", async () => {
    const api = generationApi();
    const harness = createHarness();
    await activateGenerationPair(api, harness);
    const activeWritesBefore = harness.trigger.mock.calls.filter(
      ([request]) =>
        request.function_id === "state::set" &&
        request.payload.scope === KV.graphDerivedMetadata &&
        request.payload.key === "active",
    ).length;
    const blocked = harness.blockAfterSet(
      (request) =>
        request.function_id === "state::set" &&
        request.payload.scope === KV.graphDerivedMetadata &&
        request.payload.key === "maintenance" &&
        (request.payload.value as { operation?: string }).operation === "rollback",
    );

    const first = api.rollbackDerivedIndexGeneration(harness.kv, {
      generation: "gen-one",
    });
    await blocked.reached;
    const second = api.rollbackDerivedIndexGeneration(harness.kv, {
      generation: "gen-one",
    });
    const concurrent = Promise.all([first, second]);
    blocked.release();
    await expect(concurrent).resolves.toEqual([
      expect.objectContaining({ generation: "gen-one" }),
      expect.objectContaining({ generation: "gen-one" }),
    ]);

    const activeWritesAfter = harness.trigger.mock.calls.filter(
      ([request]) =>
        request.function_id === "state::set" &&
        request.payload.scope === KV.graphDerivedMetadata &&
        request.payload.key === "active",
    ).length;
    expect(activeWritesAfter - activeWritesBefore).toBe(1);
  });

  it("fails closed when rollback marker ownership changes", async () => {
    const api = generationApi();
    const harness = createHarness();
    await activateGenerationPair(api, harness);
    const blocked = harness.blockAfterSet(
      (request) =>
        request.function_id === "state::set" &&
        request.payload.scope === KV.graphDerivedMetadata &&
        request.payload.key === "maintenance" &&
        (request.payload.value as { operation?: string }).operation === "rollback",
    );

    const rollback = api.rollbackDerivedIndexGeneration(harness.kv, {
      generation: "gen-one",
    });
    await blocked.reached;
    const foreignMarker = {
      version: 2,
      operation: "rollback",
      generation: "gen-one",
      ownerToken: "foreign-owner-token",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    harness.seed(KV.graphDerivedMetadata, "maintenance", foreignMarker);
    blocked.release();

    await expect(rollback).rejects.toThrow(/ownership/i);
    expect(
      await harness.kv.get<ActiveGeneration>(KV.graphDerivedMetadata, "active"),
    ).toMatchObject({ generation: "gen-two" });
    expect(
      await harness.kv.get(KV.graphDerivedMetadata, "maintenance"),
    ).toEqual(foreignMarker);
  });

  it("recovers one explicitly identified stale inflight row without deleting durable data", async () => {
    const api = generationApi();
    const harness = createHarness();
    const row = inflightMutation("owner-stale", "operation-stale");
    harness.seed(
      KV.graphDerivedInflight,
      "mutation-operation-stale",
      row,
    );
    harness.seed(KV.graphNodes, "node-durable", { id: "node-durable" });
    harness.seed(KV.graphDerivedMetadata, "generation:gen-durable", {
      durable: true,
    });

    const status = await api.getDerivedIndexGenerationStatus(harness.kv);
    expect(status.inFlight).toBe(true);
    expect(status.inFlightMutations).toContainEqual(
      expect.objectContaining({
        ownerToken: "owner-stale",
        operationToken: "operation-stale",
      }),
    );
    await expect(api.recoverDerivedIndexLifecycle(harness.kv, {
      minimumAgeSeconds: 60,
      expectedOwnerToken: "owner-stale",
      expectedOperationToken: "operation-stale",
    })).resolves.toEqual({
      recoveredInflight: 1,
      removedMaintenance: false,
    });

    expect(
      await harness.kv.get(KV.graphDerivedInflight, "mutation-operation-stale"),
    ).toBeNull();
    expect(await harness.kv.get(KV.graphNodes, "node-durable")).toEqual({
      id: "node-durable",
    });
    expect(
      await harness.kv.get(KV.graphDerivedMetadata, "generation:gen-durable"),
    ).toEqual({ durable: true });
  });

  it("rejects a non-expired inflight row without deleting it", async () => {
    const api = generationApi();
    const harness = createHarness();
    const row = inflightMutation("owner-current", "operation-current", {
      startedAt: new Date().toISOString(),
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    harness.seed(KV.graphDerivedInflight, "mutation-operation-current", row);

    await expect(api.recoverDerivedIndexLifecycle(harness.kv, {
      minimumAgeSeconds: 1,
      expectedOwnerToken: "owner-current",
      expectedOperationToken: "operation-current",
    })).rejects.toThrow(/not expired/i);
    expect(
      await harness.kv.get(KV.graphDerivedInflight, "mutation-operation-current"),
    ).toEqual(row);
  });

  it("rejects an expired inflight row that is still live in this process", async () => {
    const api = generationApi();
    const harness = createHarness();
    const blocked = harness.blockAfterSet(
      (request) =>
        request.function_id === "state::set" &&
        request.payload.scope === KV.graphDerivedInflight,
    );
    const writer = harness.kv.set(KV.graphNodes, "node-live", {
      id: "node-live",
      type: "concept",
      name: "Live",
      properties: {},
      sourceObservationIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies GraphNode);
    await blocked.reached;
    const inflightScope = harness.store.get(KV.graphDerivedInflight)!;
    const [rowKey, registered] = [...inflightScope.entries()][0]!;
    const liveRow = registered as Record<string, unknown>;
    inflightScope.set(rowKey, {
      ...liveRow,
      startedAt: "2000-01-01T00:00:00.000Z",
      expiresAt: "2000-01-01T00:05:00.000Z",
    });

    try {
      await expect(api.recoverDerivedIndexLifecycle(harness.kv, {
        minimumAgeSeconds: 60,
        expectedOwnerToken: liveRow.ownerToken as string,
        expectedOperationToken: liveRow.operationToken as string,
      })).rejects.toThrow(/still live/i);
      expect(inflightScope.has(rowKey)).toBe(true);
    } finally {
      blocked.release();
    }
    await expect(writer).resolves.toMatchObject({ id: "node-live" });
  });

  it("rejects a foreign inflight owner without deleting the row", async () => {
    const api = generationApi();
    const harness = createHarness();
    const row = inflightMutation("owner-original", "operation-foreign");
    harness.seed(KV.graphDerivedInflight, "mutation-operation-foreign", row);

    await expect(api.recoverDerivedIndexLifecycle(harness.kv, {
      minimumAgeSeconds: 60,
      expectedOwnerToken: "owner-foreign",
      expectedOperationToken: "operation-foreign",
    })).rejects.toThrow(/owner/i);
    expect(
      await harness.kv.get(KV.graphDerivedInflight, "mutation-operation-foreign"),
    ).toEqual(row);
  });

  it("removes only an explicitly identified orphan maintenance marker", async () => {
    const api = generationApi();
    const harness = createHarness();
    const marker = {
      version: 2,
      operation: "rebuild",
      generation: "gen-orphan",
      ownerToken: "marker-orphan",
      startedAt: "2000-01-01T00:00:00.000Z",
    };
    harness.seed(KV.graphDerivedMetadata, "maintenance", marker);
    harness.seed(KV.graphDerivedMetadata, "generation:gen-orphan", {
      durable: true,
    });
    harness.seed(KV.graphNodes, "node-durable", { id: "node-durable" });

    await expect(api.recoverDerivedIndexLifecycle(harness.kv, {
      minimumAgeSeconds: 60,
      expectedMarkerToken: "marker-orphan",
    })).resolves.toEqual({
      recoveredInflight: 0,
      removedMaintenance: true,
    });
    expect(
      await harness.kv.get(KV.graphDerivedMetadata, "maintenance"),
    ).toBeNull();
    expect(
      await harness.kv.get(KV.graphDerivedMetadata, "generation:gen-orphan"),
    ).toEqual({ durable: true });
    expect(await harness.kv.get(KV.graphNodes, "node-durable")).toEqual({
      id: "node-durable",
    });
  });

  it("cleans up a self-installed begin marker when inflight rows block begin", async () => {
    const api = generationApi();
    const harness = createHarness();
    harness.seed(
      KV.graphDerivedInflight,
      "mutation-operation-blocking",
      inflightMutation("owner-blocking", "operation-blocking"),
    );

    await expect(api.beginDerivedIndexGeneration(harness.kv, {
      generation: "gen-blocked",
    })).rejects.toThrow(/in-flight/i);
    expect(
      await harness.kv.get(KV.graphDerivedMetadata, "maintenance"),
    ).toBeNull();
  });

  it("cleans up a self-installed rollback marker when inflight rows block rollback", async () => {
    const api = generationApi();
    const harness = createHarness();
    await activateGenerationPair(api, harness);
    harness.seed(
      KV.graphDerivedInflight,
      "mutation-operation-blocking",
      inflightMutation("owner-blocking", "operation-blocking"),
    );

    await expect(api.rollbackDerivedIndexGeneration(harness.kv, {
      generation: "gen-one",
    })).rejects.toThrow(/in-flight/i);
    expect(
      await harness.kv.get(KV.graphDerivedMetadata, "maintenance"),
    ).toBeNull();
    expect(
      await harness.kv.get(KV.graphDerivedInflight, "mutation-operation-blocking"),
    ).not.toBeNull();
  });

  it("rejects rollback after canonical mutations invalidate the previous generation", async () => {
    const api = generationApi();
    const harness = createHarness();
    seedCanonicalCorpus(harness);
    await api.beginDerivedIndexGeneration(harness.kv, { generation: "gen-one" });
    await finishGeneration(api, harness.kv, "gen-one");
    await api.activateDerivedIndexGeneration(harness.kv, { generation: "gen-one" });
    await api.beginDerivedIndexGeneration(harness.kv, { generation: "gen-two" });
    await finishGeneration(api, harness.kv, "gen-two");
    await api.activateDerivedIndexGeneration(harness.kv, { generation: "gen-two" });

    await harness.kv.set(KV.graphNodes, "node-after-activation", {
      id: "node-after-activation",
      type: "concept",
      name: "After Activation",
      properties: {},
      sourceObservationIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies GraphNode);

    const status = await api.getDerivedIndexGenerationStatus(harness.kv, {
      generation: "gen-one",
    });
    expect(status.rollbackInvalidated).toBe(true);

    await expect(
      api.rollbackDerivedIndexGeneration(harness.kv, { generation: "gen-one" }),
    ).rejects.toThrow(/invalidated.*canonical mutation/i);
  });

  it("rejects activation when begin returns a complete invalidated generation", async () => {
    const api = generationApi();
    const harness = createHarness();
    await activateGenerationPair(api, harness);
    await harness.kv.set(KV.graphNodes, "node-after-activation", {
      id: "node-after-activation",
      type: "concept",
      name: "After Activation",
      properties: {},
      sourceObservationIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies GraphNode);
    const activeBefore = await harness.kv.get(
      KV.graphDerivedMetadata,
      "active",
    );
    const metadataBefore = await harness.kv.get(
      KV.graphDerivedMetadata,
      "generation:gen-one",
    );
    const generationDataBefore = [...harness.store.entries()]
      .filter(([scopeName]) => scopeName.includes("gen-one"))
      .map(([scopeName, values]) => [scopeName, [...values.entries()]]);

    const existing = await api.beginDerivedIndexGeneration(harness.kv, {
      generation: "gen-one",
    });
    expect(existing.status).toBe("complete");
    await expect(
      api.activateDerivedIndexGeneration(harness.kv, { generation: "gen-one" }),
    ).rejects.toMatchObject({
      name: "DerivedIndexLifecycleConflictError",
      message: expect.stringMatching(/invalidated.*canonical mutation/i),
    });

    expect(
      await harness.kv.get(KV.graphDerivedMetadata, "active"),
    ).toEqual(activeBefore);
    expect(
      await harness.kv.get(KV.graphDerivedMetadata, "generation:gen-one"),
    ).toEqual(metadataBefore);
    expect(
      [...harness.store.entries()]
        .filter(([scopeName]) => scopeName.includes("gen-one"))
        .map(([scopeName, values]) => [scopeName, [...values.entries()]]),
    ).toEqual(generationDataBefore);
    expect(
      await harness.kv.get(KV.graphNodes, "node-after-activation"),
    ).not.toBeNull();
  });
});
