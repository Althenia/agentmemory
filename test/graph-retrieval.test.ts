import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import {
  DERIVED_INDEX_ACTIVE_KEY,
  graphGenerationExactNameScope,
  graphGenerationNameScope,
  graphGenerationSupportLocatorsScope,
} from "../src/state/graph-derived-index.js";
import type { GraphNode, GraphEdge } from "../src/types.js";
import { KV } from "../src/state/schema.js";

const normalizeGraphTerm = (value: string): string =>
  value.normalize("NFKC").toLowerCase().trim();
const graphNameScopes = (name: string): string[] => {
  const normalized = normalizeGraphTerm(name);
  const terms = new Set([
    normalized,
    ...normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean),
  ]);
  return [...terms].map(
    (term) =>
      `mem:graph:index:name:${createHash("sha256")
        .update(term)
        .digest("hex")
        .slice(0, 32)}`,
  );
};
const graphNodeEdgesScope = (nodeId: string): string =>
  `mem:graph:index:node-edges:${encodeURIComponent(nodeId)}`;
const graphObservationNodesScope = (obsId: string): string =>
  `mem:graph:index:observation-nodes:${encodeURIComponent(obsId)}`;

function mockKV(
  nodes: GraphNode[] = [],
  edges: GraphEdge[] = [],
) {
  const store = new Map<string, Map<string, unknown>>();
  const nodesMap = new Map<string, unknown>();
  for (const n of nodes) nodesMap.set(n.id, n);
  store.set("mem:graph:nodes", nodesMap);

  const edgesMap = new Map<string, unknown>();
  for (const e of edges) edgesMap.set(e.id, e);
  store.set("mem:graph:edges", edgesMap);

  const addIndex = (scope: string, key: string): void => {
    if (!store.has(scope)) store.set(scope, new Map());
    store.get(scope)!.set(key, true);
  };
  for (const node of nodes) {
    for (const scope of graphNameScopes(node.name)) addIndex(scope, node.id);
    for (const obsId of node.sourceObservationIds) {
      addIndex(graphObservationNodesScope(obsId), node.id);
      const sessionId = `session-${obsId}`;
      if (!store.has(KV.sessions)) store.set(KV.sessions, new Map());
      store.get(KV.sessions)!.set(sessionId, {
        id: sessionId,
        project: `project-${obsId}`,
        cwd: "/workspace",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        observationCount: 1,
        agentId: `agent-${obsId}`,
      });
      if (!store.has(KV.observations(sessionId))) {
        store.set(KV.observations(sessionId), new Map());
      }
      store.get(KV.observations(sessionId))!.set(obsId, {
        id: obsId,
        sessionId,
        agentId: `agent-${obsId}`,
      });
      if (!store.has(KV.supportLocators)) store.set(KV.supportLocators, new Map());
      store.get(KV.supportLocators)!.set(obsId, {
        id: obsId,
        kind: "observation",
        sessionId,
        project: `project-${obsId}`,
        agentId: `agent-${obsId}`,
      });
    }
  }
  for (const edge of edges) {
    addIndex(graphNodeEdgesScope(edge.sourceNodeId), edge.id);
    addIndex(graphNodeEdgesScope(edge.targetNodeId), edge.id);
  }

  const list = vi.fn(async <T>(scope: string): Promise<T[]> => {
    if (scope === KV.graphNodes || scope === KV.graphEdges) {
      throw new Error(`forbidden full graph list: ${scope}`);
    }
    const entries = store.get(scope);
    return entries ? (Array.from(entries.values()) as T[]) : [];
  });
  const listPage = vi.fn(async <T>(
    scope: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: Array<{ key: string; value: T }>; nextCursor?: string }> => {
    const entries = store.get(scope);
    const sorted = entries
      ? Array.from(entries.entries()).sort(([a], [b]) => a.localeCompare(b))
      : [];
    const start = options.cursor
      ? sorted.findIndex(([key]) => key > options.cursor!)
      : 0;
    const limit = options.limit ?? 100;
    const page = (start < 0 ? [] : sorted.slice(start, start + limit));
    const hasMore = start >= 0 && start + limit < sorted.length;
    return {
      items: page.map(([key, value]) => ({ key, value: value as T })),
      ...(hasMore && page.length > 0
        ? { nextCursor: page[page.length - 1]![0] }
      : {}),
    };
  });
  const get = vi.fn(async <T>(scope: string, key: string): Promise<T | null> => {
    return (store.get(scope)?.get(key) as T) ?? null;
  });

  return {
    get,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list,
    listPage,
    seedIndex: addIndex,
    seed: (scope: string, key: string, value: unknown): void => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
    },
  };
}

function makeNode(
  id: string,
  name: string,
  type: GraphNode["type"] = "concept",
  obsIds: string[] = ["obs_1"],
): GraphNode {
  return {
    id,
    type,
    name,
    properties: {},
    sourceObservationIds: obsIds,
    createdAt: new Date().toISOString(),
  };
}

function makeEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  type: GraphEdge["type"] = "related_to",
  weight = 0.8,
): GraphEdge {
  return {
    id,
    type,
    sourceNodeId,
    targetNodeId,
    weight,
    sourceObservationIds: ["obs_1"],
    createdAt: new Date().toISOString(),
    tcommit: new Date().toISOString(),
    isLatest: true,
  };
}

describe("GraphRetrieval", () => {
  it("finds entities by name", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_1"]),
      makeNode("n2", "Vue", "library", ["obs_2"]),
    ];
    const kv = mockKV(nodes, []);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].obsId).toBe("obs_1");
  });

  it("finds entities by partial name match", async () => {
    const nodes = [makeNode("n1", "auth-middleware", "function", ["obs_1"])];
    const kv = mockKV(nodes, []);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["auth"]);
    expect(results.length).toBeGreaterThan(0);
  });

  it("traverses graph edges to find related observations", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_1"]),
      makeNode("n2", "Component", "concept", ["obs_2"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "uses")];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"], 2);
    const obsIds = results.map((r) => r.obsId);
    expect(obsIds).toContain("obs_1");
    expect(obsIds).toContain("obs_2");
  });

  it("returns empty for no matches", async () => {
    const kv = mockKV([], []);
    const retrieval = new GraphRetrieval(kv as never);
    const results = await retrieval.searchByEntities(["nonexistent"]);
    expect(results).toEqual([]);
  });

  it("expands from existing chunks", async () => {
    const nodes = [
      makeNode("n1", "auth.ts", "file", ["obs_1"]),
      makeNode("n2", "jwt", "concept", ["obs_2"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "uses")];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.expandFromChunks(["obs_1"]);
    const obsIds = results.map((r) => r.obsId);
    expect(obsIds).toContain("obs_2");
    expect(kv.list).not.toHaveBeenCalled();
  });

  it("does not duplicate already-seen observations in expansion", async () => {
    const nodes = [makeNode("n1", "file.ts", "file", ["obs_1", "obs_2"])];
    const kv = mockKV(nodes, []);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.expandFromChunks(["obs_1"]);
    const obsIds = results.map((r) => r.obsId);
    expect(obsIds).not.toContain("obs_1");
  });

  it("performs temporal query - current state", async () => {
    const nodes = [makeNode("n1", "Alice", "person", ["obs_1"])];
    const edges = [
      makeEdge("e1", "n1", "n1", "located_in" as any, 0.9),
      {
        ...makeEdge("e2", "n1", "n1", "located_in" as any, 0.9),
        tvalid: "2024-06-01",
        isLatest: true,
      },
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const result = await retrieval.temporalQuery("Alice");
    expect(result.entity).toBeDefined();
    expect(result.entity!.name).toBe("Alice");
    expect(result.currentState.length).toBeGreaterThan(0);
  });

  it("returns null entity for unknown name", async () => {
    const kv = mockKV([], []);
    const retrieval = new GraphRetrieval(kv as never);
    const result = await retrieval.temporalQuery("Unknown");
    expect(result.entity).toBeNull();
  });

  it("prefers an exact temporal name after more than 32 partial candidates", async () => {
    const partials = Array.from({ length: 40 }, (_, index) =>
      makeNode(
        `a-partial-${index.toString().padStart(2, "0")}`,
        `Auth Service ${index}`,
        "concept",
        [`obs-partial-${index}`],
      ),
    );
    const exact = makeNode("z-exact-auth", "Auth", "concept", ["obs-exact"]);
    const retrieval = new GraphRetrieval(mockKV([...partials, exact], []) as never);

    const result = await retrieval.temporalQuery("Auth");

    expect(result.entity?.id).toBe(exact.id);
    expect(result.entity?.name).toBe(exact.name);
  });

  it("reads only the active v2 generation after activation", async () => {
    const partials = Array.from({ length: 40 }, (_, index) =>
      makeNode(
        `a-v2-stale-${index.toString().padStart(2, "0")}`,
        `Auth Service ${index}`,
        "concept",
        [`obs-v2-stale-${index}`],
      ),
    );
    const exact = makeNode("z-v2-exact", "Auth", "concept", ["obs-v2-exact"]);
    const kv = mockKV([...partials, exact], []);
    kv.seed(KV.graphDerivedMetadata, DERIVED_INDEX_ACTIVE_KEY, {
      version: 2,
      generation: "gen-active",
      activatedAt: "2026-01-01T00:00:00.000Z",
      checksum: "checksum-active",
    });
    kv.seed(graphGenerationNameScope("auth", "gen-active"), exact.id, true);
    kv.seed(graphGenerationExactNameScope("Auth", "gen-active"), exact.id, true);
    kv.seed(graphGenerationSupportLocatorsScope("gen-active"), "obs-v2-exact", {
      id: "obs-v2-exact",
      kind: "observation",
      sessionId: "session-obs-v2-exact",
      project: "project-obs-v2-exact",
      agentId: "agent-obs-v2-exact",
    });
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Auth"]);
    const temporal = await retrieval.temporalQuery("Auth");

    expect(results.map((result) => result.obsId)).toEqual(["obs-v2-exact"]);
    expect(temporal.entity?.id).toBe(exact.id);
  });

  it("fails closed with migration status when active v2 exact data is missing", async () => {
    const exact = makeNode("legacy-exact", "Auth", "concept", ["obs-legacy-exact"]);
    const partial = makeNode("v2-partial", "Auth Service", "concept", ["obs-v2-partial"]);
    const kv = mockKV([exact, partial], []);
    kv.seed(KV.graphDerivedMetadata, DERIVED_INDEX_ACTIVE_KEY, {
      version: 2,
      generation: "gen-missing-exact",
      activatedAt: "2026-01-01T00:00:00.000Z",
      checksum: "checksum-missing",
    });
    kv.seed(
      graphGenerationNameScope("auth", "gen-missing-exact"),
      partial.id,
      true,
    );
    const retrieval = new GraphRetrieval(kv as never);

    const result = await retrieval.temporalQuery("Auth");

    expect(result).toMatchObject({
      entity: null,
      currentState: [],
      history: [],
      migrationStatus: expect.stringMatching(/gen-missing-exact.*exact-name/i),
    });
  });

  it("returns migration status instead of a partial when legacy exact scan is exhausted", async () => {
    const partials = Array.from({ length: 1_025 }, (_, index) =>
      makeNode(
        `a-legacy-partial-${index.toString().padStart(4, "0")}`,
        `Auth Service ${index}`,
        "concept",
        [`obs-legacy-partial-${index}`],
      ),
    );
    const exact = makeNode("z-legacy-exact", "Auth", "concept", ["obs-exact"]);
    const retrieval = new GraphRetrieval(mockKV([...partials, exact], []) as never);

    const result = await retrieval.temporalQuery("Auth");

    expect(result).toMatchObject({
      entity: null,
      migrationStatus: expect.stringMatching(/legacy.*exhausted.*v2/i),
    });
  });

  it("scores closer paths higher", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_1"]),
      makeNode("n2", "Hook", "concept", ["obs_2"]),
      makeNode("n3", "State", "concept", ["obs_3"]),
    ];
    const edges = [
      makeEdge("e1", "n1", "n2", "uses", 0.9),
      makeEdge("e2", "n2", "n3", "related_to", 0.8),
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"], 3);
    const directScore = results.find((r) => r.obsId === "obs_1")?.score ?? 0;
    const indirectScore = results.find((r) => r.obsId === "obs_3")?.score ?? 0;
    expect(directScore).toBeGreaterThan(indirectScore);
  });

  // Dijkstra path selection (#328). The BFS implementation this
  // replaced visited a node via its first-discovered path regardless
  // of edge weight. Dijkstra picks the highest-weight (lowest
  // 1/weight cost) path, so a one-hop weak edge no longer beats a
  // two-hop chain of strong edges to the same node.
  it("picks the weight-optimal path under Dijkstra, not the edge-count-shortest one (#328)", async () => {
    const nodes = [
      makeNode("n1", "Start", "concept", ["obs_start"]),
      makeNode("n2", "Mid", "concept", ["obs_mid"]),
      makeNode("n3", "End", "concept", ["obs_end"]),
    ];
    const edges = [
      // Direct n1 → n3 path with a weak edge. BFS would prefer this.
      makeEdge("e_direct", "n1", "n3", "related_to", 0.15),
      // Two-hop chain n1 → n2 → n3 with strong edges. Total cost
      // (1/0.9) + (1/0.9) ≈ 2.22, vs direct 1/0.15 ≈ 6.67.
      // Dijkstra picks the chain.
      makeEdge("e_strong_a", "n1", "n2", "related_to", 0.9),
      makeEdge("e_strong_b", "n2", "n3", "related_to", 0.9),
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Start"], 3);
    const endResult = results.find((r) => r.obsId === "obs_end");
    expect(endResult).toBeDefined();
    // Path is [Start → Mid → End] (length 3) — Dijkstra picked the
    // chain of two strong edges over the direct weak one.
    expect(endResult!.pathLength).toBe(3);
    expect(endResult!.graphContext).toContain("Mid");
    expect(kv.list).not.toHaveBeenCalled();
  });

  it("handles disconnected nodes without crashing", async () => {
    const nodes = [
      makeNode("n1", "A", "concept", ["obs_a"]),
      makeNode("n2", "B", "concept", ["obs_b"]),
      // n3 is unreachable from the matched node.
      makeNode("n3", "Lonely", "concept", ["obs_lonely"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "related_to", 0.7)];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["A"], 5);
    expect(results.find((r) => r.obsId === "obs_a")).toBeDefined();
    expect(results.find((r) => r.obsId === "obs_b")).toBeDefined();
    expect(results.find((r) => r.obsId === "obs_lonely")).toBeUndefined();
  });

  it("clamps near-zero edge weights without dividing by zero", async () => {
    const nodes = [
      makeNode("n1", "Anchor", "concept", ["obs_anchor"]),
      makeNode("n2", "Weak", "concept", ["obs_weak"]),
    ];
    // weight: 0 is malformed but we shouldn't crash on it; the clamp
    // floor at 0.01 means traversal completes with a very high cost
    // rather than throwing or producing Infinity.
    const edges = [makeEdge("e1", "n1", "n2", "related_to", 0)];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Anchor"], 2);
    const weak = results.find((r) => r.obsId === "obs_weak");
    expect(weak).toBeDefined();
    expect(Number.isFinite(weak!.score)).toBe(true);
  });

  it("scores startNode observations at 1.0 via the fallback path, not 0.5 via the path-scoring loop (#328 review)", async () => {
    // Regression for a bug surfaced by inline review on #463: if the
    // traversal includes a length-1 path for the startNode itself,
    // the generic path-scoring loop in searchByEntities computes
    // avgWeight=0.5 (empty edgeWeights → fallback) and pathLength=1,
    // yielding score=0.5, then marks the obs as visited. The
    // dedicated score=1.0 fallback loop for startNode obs is then
    // skipped via the visitedObs guard — dead code.
    const nodes = [
      makeNode("n1", "React", "library", ["obs_root"]),
      makeNode("n2", "Hook", "concept", ["obs_neighbor"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "uses", 0.8)];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"], 2);
    const root = results.find((r) => r.obsId === "obs_root");
    expect(root).toBeDefined();
    expect(root!.score).toBe(1.0);
    expect(root!.pathLength).toBe(0);
  });

  it("respects maxDepth bound (Dijkstra stops at edge-count depth)", async () => {
    // Chain n1 -> n2 -> n3 -> n4. With maxDepth=2 we should reach n3
    // but not n4 — edge-count semantics preserved from the old BFS.
    const nodes = [
      makeNode("n1", "Start", "concept", ["obs_1"]),
      makeNode("n2", "Hop1", "concept", ["obs_2"]),
      makeNode("n3", "Hop2", "concept", ["obs_3"]),
      makeNode("n4", "Hop3", "concept", ["obs_4"]),
    ];
    const edges = [
      makeEdge("e1", "n1", "n2", "related_to", 0.8),
      makeEdge("e2", "n2", "n3", "related_to", 0.8),
      makeEdge("e3", "n3", "n4", "related_to", 0.8),
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Start"], 2);
    expect(results.find((r) => r.obsId === "obs_3")).toBeDefined();
    expect(results.find((r) => r.obsId === "obs_4")).toBeUndefined();
  });

  it("uses only capped index pages and keyed graph reads", async () => {
    const nodes = [
      makeNode("n1", "Anchor", "concept", ["obs_1"]),
      makeNode("n2", "Neighbor", "concept", ["obs_2"]),
    ];
    const kv = mockKV(nodes, [makeEdge("e1", "n1", "n2")]);
    const retrieval = new GraphRetrieval(kv as never);

    await retrieval.searchByEntities(["Anchor"], 2, 20);

    expect(kv.list).not.toHaveBeenCalled();
    expect(kv.listPage).toHaveBeenCalled();
    for (const [, options] of kv.listPage.mock.calls) {
      expect(options?.limit).toBeLessThanOrEqual(128);
    }
  });

  it("bounds keyed reads for one node with 2,000 supports and maxResults 1", async () => {
    const supportIds = Array.from(
      { length: 2_000 },
      (_, index) => `obs-many-${index.toString().padStart(4, "0")}`,
    );
    const node = makeNode(
      "many-supports",
      "Many Supports Anchor",
      "concept",
      supportIds,
    );
    const kv = mockKV([node], []);
    const retrieval = new GraphRetrieval(kv as never);
    const MAX_KEYED_READS = 8;

    const results = await retrieval.searchByEntities([node.name], 1, 1);

    expect(results).toHaveLength(1);
    expect(results[0]?.obsId).toBe(supportIds.at(-1));
    expect(kv.get.mock.calls.length).toBeLessThanOrEqual(MAX_KEYED_READS);
    expect(kv.list).not.toHaveBeenCalled();
  });

  it("allocates support budget fairly across matching seeds", async () => {
    const staleIds = Array.from({ length: 64 }, (_, index) => `obs-stale-${index}`);
    const first = makeNode("a-first-seed", "Shared Seed", "concept", staleIds);
    const second = makeNode("z-second-seed", "Shared Seed", "concept", ["obs-useful"]);
    const kv = mockKV([first, second], []);
    for (const obsId of staleIds) {
      await kv.delete(KV.supportLocators, obsId);
    }
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Shared Seed"], 1, 1);

    expect(results.map((result) => result.obsId)).toEqual(["obs-useful"]);
  });

  it("filters excluded supports before charging the global expansion budget", async () => {
    const excluded = Array.from({ length: 64 }, (_, index) => `obs-excluded-${index}`);
    const nodes = [
      makeNode("excluded-start", "Excluded Start", "concept", ["obs-seed"]),
      makeNode("excluded-neighbor", "Excluded Neighbor", "concept", [
        ...excluded,
        "obs-useful",
      ]),
    ];
    const retrieval = new GraphRetrieval(
      mockKV(nodes, [makeEdge("excluded-edge", nodes[0]!.id, nodes[1]!.id)]) as never,
    );

    const results = await retrieval.expandFromChunks(["obs-seed", ...excluded], 1, 5);

    expect(results.map((result) => result.obsId)).toContain("obs-useful");
  });

  it("does not charge duplicate supports before a useful path", async () => {
    const duplicateIds = Array.from({ length: 64 }, () => "obs-duplicate");
    const nodes = [
      makeNode("duplicate-start", "Duplicate Start", "concept", ["obs-root"]),
      makeNode("a-duplicate-neighbor", "Duplicate Neighbor", "concept", duplicateIds),
      makeNode("z-useful-neighbor", "Useful Neighbor", "concept", ["obs-useful"]),
    ];
    const edges = [
      makeEdge("a-duplicate-edge", nodes[0]!.id, nodes[1]!.id),
      makeEdge("z-useful-edge", nodes[0]!.id, nodes[2]!.id),
    ];
    const retrieval = new GraphRetrieval(mockKV(nodes, edges) as never);

    const results = await retrieval.searchByEntities(["Duplicate Start"], 1, 10);

    expect(results.map((result) => result.obsId)).toContain("obs-useful");
  });

  it("caps entity seed lookups for oversized query input", async () => {
    const kv = mockKV([], []);
    const retrieval = new GraphRetrieval(kv as never);
    const entities = Array.from({ length: 100 }, (_, index) => `entity-${index}`);

    await retrieval.searchByEntities(entities);

    expect(kv.listPage.mock.calls.length).toBeLessThanOrEqual(32);
  });

  it("caps observation seed lookups for oversized expansion input", async () => {
    const kv = mockKV([], []);
    const retrieval = new GraphRetrieval(kv as never);
    const observations = Array.from({ length: 100 }, (_, index) => `obs-${index}`);

    await retrieval.expandFromChunks(observations);

    expect(kv.listPage.mock.calls.length).toBeLessThanOrEqual(32);
  });

  it("continues past stale index pages using canonical membership validation", async () => {
    const live = makeNode("z-live", "Anchor", "concept", ["obs-live"]);
    const kv = mockKV([live], []);
    const nameScope = graphNameScopes(live.name)[0]!;
    for (let i = 0; i < 130; i++) {
      kv.seedIndex(nameScope, `a-stale-${i.toString().padStart(3, "0")}`);
    }
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Anchor"]);

    expect(results.map((result) => result.obsId)).toContain("obs-live");
    expect(kv.listPage.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps shallower Dijkstra states when a cheaper max-depth path reaches the same node", async () => {
    const nodes = [
      makeNode("s", "Start", "concept", ["obs-start"]),
      makeNode("a", "Alternate", "concept", ["obs-a"]),
      makeNode("x", "Junction", "concept", ["obs-x"]),
      makeNode("y", "Reachable", "concept", ["obs-y"]),
    ];
    const edges = [
      makeEdge("direct", "s", "x", "related_to", 0.2),
      makeEdge("strong-1", "s", "a", "related_to", 0.9),
      makeEdge("strong-2", "a", "x", "related_to", 0.9),
      makeEdge("out", "x", "y", "related_to", 0.9),
    ];
    const retrieval = new GraphRetrieval(mockKV(nodes, edges) as never);

    const results = await retrieval.searchByEntities(["Start"], 2);

    expect(results.map((result) => result.obsId)).toContain("obs-y");
  });

  it("keeps the strongest result when duplicate observations arrive on different paths", async () => {
    const nodes = [
      makeNode("a-start", "Start", "concept", ["obs-root"]),
      makeNode("b-weak", "Weak", "concept", ["obs-shared"]),
      makeNode("z-start", "Start", "concept", ["obs-shared"]),
    ];
    const edges = [makeEdge("weak", "a-start", "b-weak", "related_to", 0.1)];
    const retrieval = new GraphRetrieval(mockKV(nodes, edges) as never);

    const results = await retrieval.searchByEntities(["Start"], 2);

    expect(results.find((result) => result.obsId === "obs-shared")?.score).toBe(1);
  });

  it("excludes a stale memory locator without destructively deleting it", async () => {
    const memoryId = "memory-orphan";
    const node = makeNode("memory-node", "Memory Anchor", "concept", [memoryId]);
    const kv = mockKV([node], []);
    kv.seed(KV.supportLocators, memoryId, {
      id: memoryId,
      kind: "memory",
      sessionId: "memory-session",
      project: "project-a",
      agentId: "agent-a",
    });
    const retrieval = new GraphRetrieval(kv as never);

    expect(await retrieval.searchByEntities([node.name])).toEqual([]);
    expect(await kv.get(KV.supportLocators, memoryId)).toEqual({
      id: memoryId,
      kind: "memory",
      sessionId: "memory-session",
      project: "project-a",
      agentId: "agent-a",
    });
  });

  it("uses canonical memory metadata without rewriting a stale locator", async () => {
    const memoryId = "memory-refresh";
    const node = makeNode("memory-refresh-node", "Memory Refresh Anchor", "concept", [memoryId]);
    const kv = mockKV([node], []);
    kv.seed(KV.memories, memoryId, {
      id: memoryId,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      type: "fact",
      title: "Canonical memory",
      content: "Current state",
      concepts: [],
      files: [],
      sessionIds: ["session-current"],
      strength: 1,
      version: 2,
      isLatest: true,
      project: "project-current",
      agentId: "agent-current",
    });
    kv.seed(KV.supportLocators, memoryId, {
      id: memoryId,
      kind: "memory",
      sessionId: "session-stale",
      project: "project-stale",
      agentId: "agent-stale",
    });
    const retrieval = new GraphRetrieval(kv as never);

    expect(
      (await retrieval.searchByEntities([node.name])).map((result) => result.sessionId),
    ).toEqual(["session-current"]);
    expect(await kv.get(KV.supportLocators, memoryId)).toEqual({
      id: memoryId,
      kind: "memory",
      sessionId: "session-stale",
      project: "project-stale",
      agentId: "agent-stale",
    });
  });

  it("rejects a locator aimed at another project when the canonical observation is absent there", async () => {
    const obsId = "obs-wrong-session";
    const node = makeNode("wrong-session-node", "Wrong Session Anchor", "concept", [obsId]);
    const kv = mockKV([node], []);
    kv.seed(KV.sessions, "session-foreign", {
      id: "session-foreign",
      project: "foreign-project",
      cwd: "/foreign",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      observationCount: 0,
      agentId: "foreign-agent",
    });
    kv.seed(KV.supportLocators, obsId, {
      id: obsId,
      kind: "observation",
      sessionId: "session-foreign",
      project: "foreign-project",
      agentId: "foreign-agent",
    });
    const retrieval = new GraphRetrieval(kv as never);

    expect(await retrieval.searchByEntities([node.name])).toEqual([]);
    expect(await kv.get(KV.supportLocators, obsId)).toEqual({
      id: obsId,
      kind: "observation",
      sessionId: "session-foreign",
      project: "foreign-project",
      agentId: "foreign-agent",
    });
  });

  it("excludes a locator with a missing canonical session without deleting it", async () => {
    const obsId = "obs-missing-session";
    const node = makeNode("missing-session-node", "Missing Session Anchor", "concept", [obsId]);
    const kv = mockKV([node], []);
    await kv.delete(KV.sessions, `session-${obsId}`);
    const retrieval = new GraphRetrieval(kv as never);

    expect(await retrieval.searchByEntities([node.name])).toEqual([]);
    expect(await kv.get(KV.supportLocators, obsId)).toEqual({
      id: obsId,
      kind: "observation",
      sessionId: `session-${obsId}`,
      project: `project-${obsId}`,
      agentId: `agent-${obsId}`,
    });
  });

  it("rejects an observation stored under a locator scope that disagrees with its canonical session", async () => {
    const obsId = "obs-session-mismatch";
    const node = makeNode("session-mismatch-node", "Session Mismatch Anchor", "concept", [obsId]);
    const kv = mockKV([node], []);
    const locatorSessionId = `session-${obsId}`;
    kv.seed(KV.observations(locatorSessionId), obsId, {
      id: obsId,
      sessionId: "session-other",
      agentId: "agent-other",
    });
    kv.seed(KV.sessions, "session-other", {
      id: "session-other",
      project: "project-other",
      cwd: "/other",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      observationCount: 1,
      agentId: "agent-other",
    });
    const retrieval = new GraphRetrieval(kv as never);

    expect(await retrieval.searchByEntities([node.name])).toEqual([]);
    expect(await kv.get(KV.supportLocators, obsId)).toEqual({
      id: obsId,
      kind: "observation",
      sessionId: locatorSessionId,
      project: `project-${obsId}`,
      agentId: `agent-${obsId}`,
    });
  });

  it("uses canonical observation metadata without rewriting a stale locator", async () => {
    const obsId = "obs-refresh-locator";
    const sessionId = `session-${obsId}`;
    const node = makeNode("refresh-node", "Refresh Anchor", "concept", [obsId]);
    const kv = mockKV([node], []);
    kv.seed(KV.supportLocators, obsId, {
      id: obsId,
      kind: "observation",
      sessionId,
      project: "stale-project",
      agentId: "stale-agent",
    });
    const retrieval = new GraphRetrieval(kv as never);

    expect(
      (await retrieval.searchByEntities([node.name])).map((result) => result.sessionId),
    ).toEqual([sessionId]);
    expect(await kv.get(KV.supportLocators, obsId)).toEqual({
      id: obsId,
      kind: "observation",
      sessionId,
      project: "stale-project",
      agentId: "stale-agent",
    });
  });
});
