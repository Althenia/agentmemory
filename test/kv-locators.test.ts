import { describe, expect, it, vi } from "vitest";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import {
  backfillDerivedIndexPage,
  graphNameScopes,
  graphNodeIndexEntries,
  graphNodeEdgesScope,
  graphObservationNodesScope,
} from "../src/state/graph-derived-index.js";
import type { GraphEdge, GraphNode, Session } from "../src/types.js";

function createHarness() {
  const store = new Map<string, Map<string, unknown>>();
  let failGraphRestoreAfterDerivedDelete = false;
  let failNextGraphSourceGet = false;
  let failNextSet: ((request: StateRequest) => boolean) | null = null;
  let blockedRequest: {
    predicate: (request: StateRequest) => boolean;
    reached: () => void;
    release: Promise<void>;
  } | null = null;
  let blockedAfterRequest: {
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
  const waitAfterRequest = async (request: StateRequest): Promise<void> => {
    const blockedAfter = blockedAfterRequest;
    if (blockedAfter && blockedAfter.predicate(request)) {
      blockedAfterRequest = null;
      blockedAfter.reached();
      await blockedAfter.release;
    }
  };
  const trigger = vi.fn(async (request: StateRequest) => {
    const blocked = blockedRequest;
    if (blocked && blocked.predicate(request)) {
      blockedRequest = null;
      blocked.reached();
      await blocked.release;
    }
    const payload = request.payload;
    const scopeName = payload.scope as string;
    if (request.function_id === "state::get") {
      if (
        failNextGraphSourceGet &&
        (scopeName === KV.graphNodes || scopeName === KV.graphEdges)
      ) {
        failNextGraphSourceGet = false;
        throw new Error("injected graph cleanup restore read failure");
      }
      return scope(scopeName).get(payload.key as string) ?? null;
    }
    if (request.function_id === "state::set") {
      if (failNextSet?.(request)) {
        failNextSet = null;
        throw new Error("injected state set failure");
      }
      scope(scopeName).set(payload.key as string, payload.value);
      await waitAfterRequest(request);
      return payload.value;
    }
    if (request.function_id === "state::delete") {
      scope(scopeName).delete(payload.key as string);
      if (
        failGraphRestoreAfterDerivedDelete &&
        scopeName.startsWith("mem:graph:index:")
      ) {
        failGraphRestoreAfterDerivedDelete = false;
        failNextGraphSourceGet = true;
      }
      await waitAfterRequest(request);
      return undefined;
    }
    if (request.function_id === "state::list-page") {
      const cursor = payload.cursor as string | undefined;
      const limit = (payload.limit as number | undefined) ?? 100;
      const entries = [...scope(scopeName).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([key]) => cursor === undefined || key > cursor);
      const items = entries.slice(0, limit);
      return {
        items: items.map(([key, value]) => ({ key, value })),
        ...(entries.length > limit
          ? { next_cursor: items[items.length - 1]![0] }
          : {}),
      };
    }
    throw new Error(`Unexpected function: ${request.function_id}`);
  });
  const sdk = { trigger } as never;
  return {
    kv: new StateKV(sdk),
    kv2: new StateKV(sdk),
    store,
    trigger,
    blockNext: (predicate: (request: StateRequest) => boolean) => {
      let markReached!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const waitForRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      blockedRequest = { predicate, reached: markReached, release: waitForRelease };
      return { reached, release };
    },
    blockAfterNext: (predicate: (request: StateRequest) => boolean) => {
      let markReached!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const waitForRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      blockedAfterRequest = {
        predicate,
        reached: markReached,
        release: waitForRelease,
      };
      return { reached, release };
    },
    failGraphRestoreOnce: () => {
      failGraphRestoreAfterDerivedDelete = true;
    },
    failSetOnce: (predicate: (request: StateRequest) => boolean) => {
      failNextSet = predicate;
    },
  };
}

interface StateRequest {
  function_id: string;
  payload: Record<string, unknown>;
}

describe("StateKV get contract", () => {
  it("normalizes an undefined state::get result to null", async () => {
    const trigger = vi.fn(async () => undefined);
    const kv = new StateKV({ trigger } as never);
    const raw = kv as unknown as {
      getRaw<T>(scope: string, key: string): Promise<T | null>;
    };

    await expect(raw.getRaw("scope", "missing")).resolves.toBeNull();
    await expect(kv.get("scope", "missing")).resolves.toBeNull();
  });

  it.each([false, 0, ""])("preserves the non-null value %j", async (value) => {
    const kv = new StateKV({
      trigger: vi.fn(async () => value),
    } as never);

    await expect(kv.get("scope", "key")).resolves.toBe(value);
  });

  it("propagates state::get errors", async () => {
    const kv = new StateKV({
      trigger: vi.fn(async () => {
        throw new Error("state read failed");
      }),
    } as never);

    await expect(kv.get("scope", "key")).rejects.toThrow("state read failed");
  });
});

describe("StateKV derived records", () => {
  const V2_METADATA_SCOPE = "mem:graph:index:v2:metadata";
  const V2_ACTIVE_KEY = "active";
  const V2_MAINTENANCE_KEY = "maintenance";
  const V2_GENERATION_PREFIX = "mem:graph:index:v2:gen-a:";

  it("forwards bounded keyed pages and maps next_cursor", async () => {
    const { kv } = createHarness();
    await kv.set("scope", "a", 1);
    await kv.set("scope", "b", 2);

    const page = await kv.listPage<number>("scope", { limit: 1 });

    expect(page).toEqual({
      items: [{ key: "a", value: 1 }],
      nextCursor: "a",
    });
  });

  it("writes an exact observation locator and fails closed after canonical delete", async () => {
    const { kv, store } = createHarness();
    const session: Session = {
      id: "session-1",
      project: "project-a",
      cwd: "/workspace",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      observationCount: 1,
      agentId: "agent-a",
    };
    await kv.set(KV.sessions, session.id, session);

    await kv.set(KV.observations(session.id), "obs-1", {
      id: "obs-1",
      sessionId: session.id,
      agentId: "agent-a",
    });
    expect(store.get(KV.supportLocators)?.get("obs-1")).toEqual({
      id: "obs-1",
      kind: "observation",
      sessionId: "session-1",
      project: "project-a",
      agentId: "agent-a",
    });
    const node: GraphNode = {
      id: "node-observation-delete",
      type: "concept",
      name: "ObservationDeleteAnchor",
      properties: {},
      sourceObservationIds: ["obs-1"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await kv.set(KV.graphNodes, node.id, node);

    await kv.delete(KV.observations(session.id), "obs-1");
    expect(store.get(KV.supportLocators)?.has("obs-1")).toBe(true);
    expect(await new GraphRetrieval(kv).searchByEntities([node.name])).toEqual([]);
  });

  it("does not commit canonical graph state when active-generation prewrite fails", async () => {
    const { kv, store, failSetOnce } = createHarness();
    store.set(V2_METADATA_SCOPE, new Map([
      [V2_ACTIVE_KEY, {
        version: 2,
        generation: "gen-a",
        activatedAt: "2026-01-01T00:00:00.000Z",
        checksum: "checksum-a",
      }],
    ]));
    const node: GraphNode = {
      id: "node-prewrite-failure",
      type: "concept",
      name: "Prewrite Failure",
      properties: {},
      sourceObservationIds: ["obs-prewrite-failure"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    failSetOnce(
      (request) =>
        request.function_id === "state::set" &&
        String(request.payload.scope).startsWith(V2_GENERATION_PREFIX),
    );

    await expect(kv.set(KV.graphNodes, node.id, node)).rejects.toThrow(
      "injected state set failure",
    );
    expect(await kv.get(KV.graphNodes, node.id)).toBeNull();
  });

  it("prewrites active-generation memberships before a canonical graph failure", async () => {
    const { kv, store, failSetOnce } = createHarness();
    store.set(V2_METADATA_SCOPE, new Map([
      [V2_ACTIVE_KEY, {
        version: 2,
        generation: "gen-a",
        activatedAt: "2026-01-01T00:00:00.000Z",
        checksum: "checksum-a",
      }],
    ]));
    const node: GraphNode = {
      id: "node-canonical-failure",
      type: "concept",
      name: "Canonical Failure",
      properties: {},
      sourceObservationIds: ["obs-canonical-failure"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    failSetOnce(
      (request) =>
        request.function_id === "state::set" &&
        request.payload.scope === KV.graphNodes,
    );

    await expect(kv.set(KV.graphNodes, node.id, node)).rejects.toThrow(
      "injected state set failure",
    );
    expect(await kv.get(KV.graphNodes, node.id)).toBeNull();
    expect(
      [...store.entries()].some(
        ([scopeName, values]) =>
          scopeName.startsWith(V2_GENERATION_PREFIX) && values.has(node.id),
      ),
    ).toBe(true);
  });

  it("does not commit canonical memory when active support-locator prewrite fails", async () => {
    const { kv, store, failSetOnce } = createHarness();
    store.set(V2_METADATA_SCOPE, new Map([
      [V2_ACTIVE_KEY, {
        version: 2,
        generation: "gen-a",
        activatedAt: "2026-01-01T00:00:00.000Z",
        checksum: "checksum-a",
      }],
    ]));
    const memoryId = "memory-prewrite-failure";
    failSetOnce(
      (request) =>
        request.function_id === "state::set" &&
        request.payload.scope === `${V2_GENERATION_PREFIX}support-locators`,
    );

    await expect(kv.set(KV.memories, memoryId, {
      id: memoryId,
      sessionIds: ["session-a"],
      project: "project-a",
    })).rejects.toThrow("injected state set failure");
    expect(await kv.get(KV.memories, memoryId)).toBeNull();
  });

  it("rejects relevant canonical set and delete mutations during maintenance", async () => {
    const { kv, store } = createHarness();
    store.set(V2_METADATA_SCOPE, new Map([
      [V2_MAINTENANCE_KEY, {
        version: 2,
        operation: "rebuild",
        generation: "gen-a",
        startedAt: "2026-01-01T00:00:00.000Z",
      }],
    ]));
    const node: GraphNode = {
      id: "node-maintenance",
      type: "concept",
      name: "Maintenance",
      properties: {},
      sourceObservationIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    await expect(kv.set(KV.graphNodes, node.id, node)).rejects.toThrow(
      /maintenance/i,
    );
    await expect(kv.delete(KV.graphNodes, node.id)).rejects.toThrow(
      /maintenance/i,
    );
    expect(await kv.get(KV.graphNodes, node.id)).toBeNull();
  });

  it("retains the newest 32 unique graph supports for reverse indexing", () => {
    const supportIds = Array.from({ length: 40 }, (_, index) => `obs-${index}`);
    const entries = graphNodeIndexEntries({
      id: "node-newest-supports",
      type: "concept",
      name: "Newest Supports",
      properties: {},
      sourceObservationIds: [...supportIds, "obs-39", "obs-38"],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const indexedScopes = new Set(entries.map((entry) => entry.scope));

    for (const id of supportIds.slice(0, 8)) {
      expect(indexedScopes.has(graphObservationNodesScope(id))).toBe(false);
    }
    for (const id of supportIds.slice(8)) {
      expect(indexedScopes.has(graphObservationNodesScope(id))).toBe(true);
    }
  });

  it("keeps a newer memory locator when an older delete finishes last", async () => {
    const { kv, kv2, store, blockAfterNext } = createHarness();
    const memoryId = "memory-concurrent-delete";
    const initial = {
      id: memoryId,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      type: "fact",
      title: "Initial memory",
      content: "Initial content",
      concepts: [],
      files: [],
      sessionIds: ["session-initial"],
      strength: 1,
      version: 1,
      isLatest: true,
      project: "project-a",
      agentId: "agent-a",
    };
    const final = {
      ...initial,
      updatedAt: "2026-01-02T00:00:00.000Z",
      title: "Final memory",
      sessionIds: ["session-final"],
      version: 2,
      agentId: "agent-final",
    };
    await kv.set(KV.memories, memoryId, initial);

    const pausedCanonicalDelete = blockAfterNext(
      (request) =>
        request.function_id === "state::delete" &&
        request.payload.scope === KV.memories &&
        request.payload.key === memoryId,
    );
    const deletion = kv.delete(KV.memories, memoryId);
    await pausedCanonicalDelete.reached;
    await kv2.set(KV.memories, memoryId, final);
    pausedCanonicalDelete.release();
    await deletion;

    expect(await kv.get(KV.memories, memoryId)).toEqual(final);
    expect(store.get(KV.supportLocators)?.get(memoryId)).toEqual({
      id: memoryId,
      kind: "memory",
      sessionId: "session-final",
      project: "project-a",
      agentId: "agent-final",
    });
  });

  it("keeps a newer observation locator when an older delete finishes last", async () => {
    const { kv, kv2, store, blockAfterNext } = createHarness();
    const session: Session = {
      id: "session-observation-delete-race",
      project: "project-a",
      cwd: "/workspace",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      observationCount: 1,
      agentId: "agent-a",
    };
    const observationId = "obs-concurrent-delete";
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), observationId, {
      id: observationId,
      sessionId: session.id,
      agentId: "agent-initial",
    });

    const pausedCanonicalDelete = blockAfterNext(
      (request) =>
        request.function_id === "state::delete" &&
        request.payload.scope === KV.observations(session.id) &&
        request.payload.key === observationId,
    );
    const deletion = kv.delete(KV.observations(session.id), observationId);
    await pausedCanonicalDelete.reached;
    await kv2.set(KV.observations(session.id), observationId, {
      id: observationId,
      sessionId: session.id,
      agentId: "agent-final",
    });
    pausedCanonicalDelete.release();
    await deletion;

    expect(await kv.get(KV.observations(session.id), observationId)).toEqual({
      id: observationId,
      sessionId: session.id,
      agentId: "agent-final",
    });
    expect(store.get(KV.supportLocators)?.get(observationId)).toEqual({
      id: observationId,
      kind: "observation",
      sessionId: session.id,
      project: "project-a",
      agentId: "agent-final",
    });
  });

  it("retains stale graph memberships for canonical read-time validation", async () => {
    const { kv, store } = createHarness();
    const first: GraphNode = {
      id: "node-1",
      type: "concept",
      name: "Auth Middleware",
      properties: {},
      sourceObservationIds: ["obs-1"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await kv.set(KV.graphNodes, first.id, first);
    for (const nameScope of graphNameScopes(first.name)) {
      expect(store.get(nameScope)?.has(first.id)).toBe(true);
    }
    expect(store.get(graphObservationNodesScope("obs-1"))?.has(first.id)).toBe(true);

    const replacement = {
      ...first,
      name: "Session Cache",
      sourceObservationIds: ["obs-2"],
    };
    await kv.set(KV.graphNodes, replacement.id, replacement);
    const replacementScopes = new Set(graphNameScopes(replacement.name));
    for (const nameScope of graphNameScopes(first.name).filter(
      (scope) => !replacementScopes.has(scope),
    )) {
      expect(store.get(nameScope)?.has(first.id)).toBe(true);
    }
    expect(store.get(graphObservationNodesScope("obs-1"))?.has(first.id)).toBe(true);
    expect(store.get(graphObservationNodesScope("obs-2"))?.has(first.id)).toBe(true);
    expect(await new GraphRetrieval(kv).searchByEntities([first.name])).toEqual([]);
    expect(await new GraphRetrieval(kv).expandFromChunks(["obs-1"])).toEqual([]);

    const edge: GraphEdge = {
      id: "edge-1",
      type: "related_to",
      sourceNodeId: "node-1",
      targetNodeId: "node-2",
      weight: 0.8,
      sourceObservationIds: ["obs-2"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await kv.set(KV.graphEdges, edge.id, edge);
    expect(store.get(graphNodeEdgesScope("node-1"))?.has(edge.id)).toBe(true);
    expect(store.get(graphNodeEdgesScope("node-2"))?.has(edge.id)).toBe(true);

    await kv.delete(KV.graphEdges, edge.id);
    expect(store.get(graphNodeEdgesScope("node-1"))?.has(edge.id)).toBe(true);
    expect(store.get(graphNodeEdgesScope("node-2"))?.has(edge.id)).toBe(true);
    expect(await kv.get(KV.graphEdges, edge.id)).toBeNull();
  });

  it("backfills one bounded canonical page and returns its cursor", async () => {
    const { kv, store, trigger } = createHarness();
    const nodes: GraphNode[] = [
      {
        id: "node-1",
        type: "concept",
        name: "First Node",
        properties: {},
        sourceObservationIds: ["obs-1"],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "node-2",
        type: "concept",
        name: "Second Node",
        properties: {},
        sourceObservationIds: ["obs-2"],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    for (const node of nodes) {
      store.set(KV.graphNodes, store.get(KV.graphNodes) ?? new Map());
      store.get(KV.graphNodes)!.set(node.id, node);
    }

    const result = await backfillDerivedIndexPage(kv, {
      kind: "graph-nodes",
      limit: 1,
    });

    expect(result).toEqual({ processed: 1, nextCursor: "node-1", complete: false });
    expect(store.get(graphObservationNodesScope("obs-1"))?.has("node-1")).toBe(true);
    expect(
      trigger.mock.calls.some(
        ([request]) =>
          request.function_id === "state::list-page" &&
          request.payload.scope === KV.graphNodes &&
          request.payload.limit === 1,
      ),
    ).toBe(true);
  });

  it("bounds derived-index writes for one graph node with 2,000 supports", async () => {
    const { kv, store, trigger } = createHarness();
    const supportIds = Array.from(
      { length: 2_000 },
      (_, index) => `obs-${index.toString().padStart(4, "0")}`,
    );
    const node: GraphNode = {
      id: "node-many-supports",
      type: "concept",
      name: "Many Supports",
      properties: {},
      sourceObservationIds: supportIds,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    store.set(KV.graphNodes, new Map([[node.id, node]]));

    const result = await backfillDerivedIndexPage(kv, {
      kind: "graph-nodes",
      limit: 1,
    });
    const derivedWrites = trigger.mock.calls.filter(
      ([request]) =>
        request.function_id === "state::set" &&
        String(request.payload.scope).startsWith("mem:graph:index:"),
    );
    const MAX_DERIVED_WRITES_PER_GRAPH_NODE = 49;

    expect(result.processed).toBe(1);
    expect(derivedWrites.length).toBeLessThanOrEqual(
      MAX_DERIVED_WRITES_PER_GRAPH_NODE,
    );
    expect(
      store.get(graphObservationNodesScope(supportIds.at(-1)!))?.has(node.id),
    ).toBe(true);
    expect(
      store.get(graphObservationNodesScope(supportIds[0]!))?.has(node.id),
    ).not.toBe(true);
  });

  it("fails closed for stale graph memberships retained after overwrite", async () => {
    const { kv, store } = createHarness();
    const first: GraphNode = {
      id: "node-1",
      type: "concept",
      name: "Old Name",
      properties: {},
      sourceObservationIds: ["obs-old"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const replacement: GraphNode = {
      ...first,
      name: "New Name",
      sourceObservationIds: ["obs-new"],
    };
    await kv.set(KV.graphNodes, first.id, first);

    await kv.set(KV.graphNodes, replacement.id, replacement);

    expect(await new GraphRetrieval(kv).searchByEntities([first.name])).toEqual([]);
    expect(await new GraphRetrieval(kv).expandFromChunks(["obs-old"])).toEqual([]);

    const liveScopes = new Set(graphNameScopes(replacement.name));
    for (const nameScope of graphNameScopes(first.name).filter(
      (scope) => !liveScopes.has(scope),
    )) {
      expect(store.get(nameScope)?.has(first.id)).toBe(true);
    }
    expect(store.get(graphObservationNodesScope("obs-old"))?.has(first.id)).toBe(true);
    for (const nameScope of graphNameScopes(replacement.name)) {
      expect(store.get(nameScope)?.has(first.id)).toBe(true);
    }
    expect(store.get(graphObservationNodesScope("obs-new"))?.has(first.id)).toBe(true);
  });

  it("keeps a newer canonical graph membership discoverable when cleanup restore fails", async () => {
    const { kv, kv2, blockNext, failGraphRestoreOnce } = createHarness();
    const session: Session = {
      id: "session-cleanup-restore-failure",
      project: "project-a",
      cwd: "/workspace",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      observationCount: 1,
      agentId: "agent-a",
    };
    const observationId = "obs-cleanup-restore-failure";
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), observationId, {
      id: observationId,
      sessionId: session.id,
      agentId: session.agentId,
    });
    const initial: GraphNode = {
      id: "node-cleanup-restore-failure",
      type: "concept",
      name: "CleanupRestoreAnchor",
      properties: { revision: "initial" },
      sourceObservationIds: [observationId],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const final: GraphNode = {
      ...initial,
      properties: { revision: "final" },
    };
    await kv.set(KV.graphNodes, initial.id, initial);

    const pausedCleanupDelete = blockNext(
      (request) =>
        request.function_id === "state::delete" &&
        request.payload.scope === graphNameScopes(initial.name)[0] &&
        request.payload.key === initial.id,
    );
    const deletion = kv.delete(KV.graphNodes, initial.id);
    const phase = await Promise.race([
      pausedCleanupDelete.reached.then(() => "cleanup" as const),
      deletion.then(() => "complete" as const),
    ]);
    if (phase === "cleanup") {
      await kv2.set(KV.graphNodes, final.id, final);
      failGraphRestoreOnce();
      pausedCleanupDelete.release();
      await expect(deletion).rejects.toThrow(
        "injected graph cleanup restore read failure",
      );
    } else {
      pausedCleanupDelete.release();
      await kv2.set(KV.graphNodes, final.id, final);
    }

    expect(await kv.get(KV.graphNodes, final.id)).toEqual(final);
    expect(
      (await new GraphRetrieval(kv).searchByEntities([final.name])).map(
        (result) => result.obsId,
      ),
    ).toContain(observationId);
  });

  it("keeps the final set discoverable when two StateKV instances interleave set operations", async () => {
    const { kv, kv2, store, blockAfterNext } = createHarness();
    const session: Session = {
      id: "session-concurrent-set",
      project: "project-a",
      cwd: "/workspace",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      observationCount: 1,
      agentId: "agent-a",
    };
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), "obs-concurrent-set", {
      id: "obs-concurrent-set",
      sessionId: session.id,
      agentId: session.agentId,
    });
    const initial: GraphNode = {
      id: "node-concurrent-set",
      type: "concept",
      name: "Stable Alpha",
      properties: { revision: "initial" },
      sourceObservationIds: ["obs-concurrent-set"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const intermediate: GraphNode = {
      ...initial,
      name: "Transient Beta",
      properties: { revision: "intermediate" },
    };
    const final: GraphNode = {
      ...initial,
      properties: { revision: "final" },
    };
    await kv.set(KV.graphNodes, initial.id, initial);

    const pausedCanonicalSet = blockAfterNext(
      (request) =>
        request.function_id === "state::set" &&
        request.payload.scope === KV.graphNodes &&
        request.payload.key === intermediate.id &&
        (request.payload.value as GraphNode).properties.revision === "intermediate",
    );
    const firstSet = kv.set(KV.graphNodes, intermediate.id, intermediate);
    await pausedCanonicalSet.reached;
    await kv2.set(KV.graphNodes, final.id, final);
    pausedCanonicalSet.release();
    await firstSet;

    expect(await kv.get(KV.graphNodes, final.id)).toEqual(final);
    const retrieval = new GraphRetrieval(kv);
    expect(await retrieval.searchByEntities([intermediate.name])).toEqual([]);
    expect(
      (await retrieval.searchByEntities([final.name])).map((result) => result.obsId),
    ).toContain("obs-concurrent-set");
    for (const entry of graphNodeIndexEntries(final)) {
      expect(store.get(entry.scope)?.has(entry.key)).toBe(true);
    }
  });

  it("keeps a final set discoverable when another StateKV delete repair finishes last", async () => {
    const { kv, kv2, store, blockAfterNext } = createHarness();
    const session: Session = {
      id: "session-concurrent-delete",
      project: "project-a",
      cwd: "/workspace",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      observationCount: 1,
      agentId: "agent-a",
    };
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), "obs-concurrent-delete", {
      id: "obs-concurrent-delete",
      sessionId: session.id,
      agentId: session.agentId,
    });
    const initial: GraphNode = {
      id: "node-concurrent-delete",
      type: "concept",
      name: "Delete Race Anchor",
      properties: { revision: "initial" },
      sourceObservationIds: ["obs-concurrent-delete"],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const final: GraphNode = {
      ...initial,
      properties: { revision: "final" },
    };
    await kv.set(KV.graphNodes, initial.id, initial);

    const pausedCanonicalDelete = blockAfterNext(
      (request) =>
        request.function_id === "state::delete" &&
        request.payload.scope === KV.graphNodes &&
        request.payload.key === initial.id,
    );
    const deletion = kv.delete(KV.graphNodes, initial.id);
    await pausedCanonicalDelete.reached;
    await kv2.set(KV.graphNodes, final.id, final);
    pausedCanonicalDelete.release();
    await deletion;

    expect(await kv.get(KV.graphNodes, final.id)).toEqual(final);
    expect(
      (await new GraphRetrieval(kv).searchByEntities([final.name])).map(
        (result) => result.obsId,
      ),
    ).toContain("obs-concurrent-delete");
    for (const entry of graphNodeIndexEntries(final)) {
      expect(store.get(entry.scope)?.has(entry.key)).toBe(true);
    }
  });
});
