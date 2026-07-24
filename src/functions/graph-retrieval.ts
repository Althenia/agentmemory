import type {
  GraphNode,
  GraphEdge,
  Memory,
  Session,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  getActiveDerivedIndexGeneration,
  graphExactNameScope,
  graphGenerationExactNameScope,
  graphGenerationNameScope,
  graphGenerationNodeEdgesScope,
  graphGenerationObservationNodesScope,
  graphGenerationSupportLocatorsScope,
  graphNameScope,
  graphNameTerms,
  graphNodeEdgesScope,
  graphObservationNodesScope,
  normalizeGraphTerm,
  retainedGraphSupportIds,
  type SupportLocator,
} from "../state/graph-derived-index.js";

const INDEX_PAGE_LIMIT = 128;
const MAX_INDEX_PAGES = 8;
const MAX_START_NODES = 32;
const MAX_EXACT_NAME_CANDIDATES = INDEX_PAGE_LIMIT * MAX_INDEX_PAGES;
const MAX_SUPPORT_CANDIDATES = 64;
const MAX_TRAVERSAL_NODES = 1000;

interface RetrievalContext {
  nodeCache: Map<string, Promise<GraphNode | null>>;
  edgeCache: Map<string, Promise<GraphEdge | null>>;
  locatorCache: Map<string, Promise<SupportLocator | null>>;
  sessionCache: Map<string, Promise<Session | null>>;
  incidentEdgesCache: Map<string, Promise<GraphEdge[]>>;
  seedIndexCache: Map<string, Promise<IndexKeys>>;
  supportCandidates: number;
  seenSupportIds: Set<string>;
  generation?: string;
}

interface IndexKeys {
  keys: string[];
  exhausted: boolean;
}

interface ExactNodeResult {
  nodes: GraphNode[];
  exhausted: boolean;
}

export interface GraphRetrievalResult {
  obsId: string;
  sessionId: string;
  score: number;
  graphContext: string;
  pathLength: number;
}

function buildGraphContext(
  path: Array<{ node: GraphNode; edge?: GraphEdge }>,
): string {
  const parts: string[] = [];
  for (const step of path) {
    const props = Object.entries(step.node.properties)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    let line = `[${step.node.type}] ${step.node.name}`;
    if (props) line += ` (${props})`;
    if (step.edge) {
      line += ` --${step.edge.type}-->`;
      if (step.edge.context?.reasoning) {
        line += ` [${step.edge.context.reasoning}]`;
      }
      if (step.edge.tvalid) {
        line += ` @${step.edge.tvalid}`;
      }
    }
    parts.push(line);
  }
  return parts.join(" ");
}

export class GraphRetrieval {
  constructor(private kv: StateKV) {}

  private async createContext(): Promise<RetrievalContext> {
    const active = await getActiveDerivedIndexGeneration(this.kv);
    return {
      nodeCache: new Map(),
      edgeCache: new Map(),
      locatorCache: new Map(),
      sessionCache: new Map(),
      incidentEdgesCache: new Map(),
      seedIndexCache: new Map(),
      supportCandidates: 0,
      seenSupportIds: new Set(),
      ...(active ? { generation: active.generation } : {}),
    };
  }

  private async indexKeys(
    scope: string,
    maxKeys = INDEX_PAGE_LIMIT * MAX_INDEX_PAGES,
  ): Promise<IndexKeys> {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (
      let pageNumber = 0;
      pageNumber < MAX_INDEX_PAGES && keys.length < maxKeys;
      pageNumber++
    ) {
      const page = await this.kv.listPage<boolean>(scope, {
        ...(cursor !== undefined ? { cursor } : {}),
        limit: Math.min(INDEX_PAGE_LIMIT, maxKeys - keys.length),
      });
      keys.push(
        ...page.items
          .slice(0, maxKeys - keys.length)
          .map((item) => item.key),
      );
      if (page.nextCursor === undefined) {
        return { keys, exhausted: false };
      }
      cursor = page.nextCursor;
    }
    return { keys, exhausted: cursor !== undefined };
  }

  private seedKeys(
    scope: string,
    context: RetrievalContext,
  ): Promise<IndexKeys> {
    let pending = context.seedIndexCache.get(scope);
    if (!pending) {
      if (context.seedIndexCache.size >= MAX_START_NODES) {
        return Promise.resolve({ keys: [], exhausted: true });
      }
      pending = this.indexKeys(scope);
      context.seedIndexCache.set(scope, pending);
    }
    return pending;
  }

  private nameScope(term: string, context: RetrievalContext): string {
    return context.generation
      ? graphGenerationNameScope(term, context.generation)
      : graphNameScope(term);
  }

  private exactNameScope(name: string, context: RetrievalContext): string {
    return context.generation
      ? graphGenerationExactNameScope(name, context.generation)
      : graphExactNameScope(name);
  }

  private nodeEdgesScope(nodeId: string, context: RetrievalContext): string {
    return context.generation
      ? graphGenerationNodeEdgesScope(nodeId, context.generation)
      : graphNodeEdgesScope(nodeId);
  }

  private observationNodesScope(
    obsId: string,
    context: RetrievalContext,
  ): string {
    return context.generation
      ? graphGenerationObservationNodesScope(obsId, context.generation)
      : graphObservationNodesScope(obsId);
  }

  private supportLocatorsScope(context: RetrievalContext): string {
    return context.generation
      ? graphGenerationSupportLocatorsScope(context.generation)
      : KV.supportLocators;
  }

  private loadNode(
    nodeId: string,
    context: RetrievalContext,
  ): Promise<GraphNode | null> {
    let pending = context.nodeCache.get(nodeId);
    if (!pending) {
      pending = this.kv
        .get<GraphNode>(KV.graphNodes, nodeId)
        .then((node) => node && !node.stale ? node : null);
      context.nodeCache.set(nodeId, pending);
    }
    return pending;
  }

  private loadEdge(
    edgeId: string,
    context: RetrievalContext,
  ): Promise<GraphEdge | null> {
    let pending = context.edgeCache.get(edgeId);
    if (!pending) {
      pending = this.kv
        .get<GraphEdge>(KV.graphEdges, edgeId)
        .then((edge) => edge && !edge.stale ? edge : null);
      context.edgeCache.set(edgeId, pending);
    }
    return pending;
  }

  private loadSession(
    sessionId: string,
    context: RetrievalContext,
  ): Promise<Session | null> {
    let pending = context.sessionCache.get(sessionId);
    if (!pending) {
      pending = this.kv.get<Session>(KV.sessions, sessionId);
      context.sessionCache.set(sessionId, pending);
    }
    return pending;
  }

  private loadLocator(
    obsId: string,
    context: RetrievalContext,
  ): Promise<SupportLocator | null> {
    let pending = context.locatorCache.get(obsId);
    if (!pending) {
      pending = this.readCanonicalLocator(obsId, context);
      context.locatorCache.set(obsId, pending);
    }
    return pending;
  }

  private async readCanonicalLocator(
    obsId: string,
    context: RetrievalContext,
  ): Promise<SupportLocator | null> {
    const locator = await this.kv.get<SupportLocator>(
      this.supportLocatorsScope(context),
      obsId,
    );
    if (!locator) return null;

    if (locator.kind === "memory") {
      const memory = await this.kv.get<Memory>(KV.memories, obsId);
      if (memory?.id === obsId) {
        return {
          id: obsId,
          kind: "memory",
          sessionId: memory.sessionIds?.[0] ?? "memory",
          ...(memory.project ? { project: memory.project } : {}),
          ...(memory.agentId ? { agentId: memory.agentId } : {}),
        };
      }
      return null;
    }

    if (locator.kind === "observation") {
      const observation = await this.kv.get<{
        id?: string;
        sessionId?: string;
        agentId?: string;
      }>(KV.observations(locator.sessionId), obsId);
      if (
        observation?.id === obsId &&
        observation.sessionId === locator.sessionId
      ) {
        const session = await this.loadSession(locator.sessionId, context);
        if (session?.id === locator.sessionId) {
          const agentId = observation.agentId ?? session.agentId;
          return {
            id: obsId,
            kind: "observation",
            sessionId: locator.sessionId,
            ...(session.project ? { project: session.project } : {}),
            ...(agentId ? { agentId } : {}),
          };
        }
      }
    }
    return null;
  }

  private fairSupportCandidates<T>(
    groups: Array<{ ids: string[]; owner: T }>,
    context: RetrievalContext,
    excluded = new Set<string>(),
  ): Array<{ obsId: string; owner: T }> {
    const queues = groups.map((group) => ({
      owner: group.owner,
      ids: retainedGraphSupportIds(group.ids).reverse(),
      cursor: 0,
    }));
    const selected: Array<{ obsId: string; owner: T }> = [];
    let advanced = true;
    while (advanced) {
      advanced = false;
      for (const queue of queues) {
        while (queue.cursor < queue.ids.length) {
          const obsId = queue.ids[queue.cursor++]!;
          advanced = true;
          if (excluded.has(obsId)) continue;
          if (!context.seenSupportIds.has(obsId)) {
            if (context.supportCandidates >= MAX_SUPPORT_CANDIDATES) continue;
            context.seenSupportIds.add(obsId);
            context.supportCandidates++;
          }
          selected.push({ obsId, owner: queue.owner });
          break;
        }
      }
    }
    return selected;
  }

  private async findExactNodes(
    entityNames: string[],
    context: RetrievalContext,
  ): Promise<ExactNodeResult> {
    const exactTerms = [
      ...new Set(entityNames.map(normalizeGraphTerm).filter(Boolean)),
    ].slice(0, MAX_START_NODES);
    const matches = new Map<string, GraphNode>();
    let exhausted = false;
    for (const term of exactTerms) {
      let foundForTerm = false;
      const exactIndex = await this.seedKeys(
        this.exactNameScope(term, context),
        context,
      );
      exhausted ||= exactIndex.exhausted;
      for (const nodeId of exactIndex.keys.slice(0, MAX_EXACT_NAME_CANDIDATES)) {
        const node = await this.loadNode(nodeId, context);
        if (node && normalizeGraphTerm(node.name) === term) {
          matches.set(node.id, node);
          foundForTerm = true;
          if (matches.size >= MAX_START_NODES) {
            return { nodes: [...matches.values()], exhausted };
          }
        }
      }
      if (foundForTerm || context.generation) continue;

      const legacyIndex = await this.seedKeys(
        graphNameScope(term),
        context,
      );
      exhausted ||= legacyIndex.exhausted;
      for (const nodeId of legacyIndex.keys.slice(0, MAX_EXACT_NAME_CANDIDATES)) {
        const node = await this.loadNode(nodeId, context);
        if (node && normalizeGraphTerm(node.name) === term) {
          matches.set(node.id, node);
          break;
        }
      }
      if (matches.size >= MAX_START_NODES) break;
    }
    return { nodes: [...matches.values()], exhausted };
  }

  private async findNodesByEntities(
    entityNames: string[],
    context: RetrievalContext,
  ): Promise<GraphNode[]> {
    const nodes = new Map<string, GraphNode>();
    const requestedTerms = new Set(
      entityNames.flatMap(graphNameTerms).slice(0, MAX_START_NODES),
    );
    for (const term of requestedTerms) {
      const scope = this.nameScope(term, context);
      const index = await this.seedKeys(scope, context);
      for (const nodeId of index.keys) {
        const node = await this.loadNode(nodeId, context);
        if (node && graphNameTerms(node.name).includes(term)) {
          nodes.set(node.id, node);
        }
        if (nodes.size >= MAX_START_NODES) break;
      }
      if (nodes.size >= MAX_START_NODES) break;
    }
    return [...nodes.values()];
  }

  private async findNodesByObservations(
    obsIds: string[],
    context: RetrievalContext,
  ): Promise<GraphNode[]> {
    const requestedObsIds = new Set(obsIds.slice(0, MAX_START_NODES));
    const nodes = new Map<string, GraphNode>();
    for (const obsId of requestedObsIds) {
      const index = await this.seedKeys(
        this.observationNodesScope(obsId, context),
        context,
      );
      for (const nodeId of index.keys) {
        const node = await this.loadNode(nodeId, context);
        if (node && node.sourceObservationIds.includes(obsId)) {
          nodes.set(node.id, node);
        }
        if (nodes.size >= MAX_START_NODES) break;
      }
      if (nodes.size >= MAX_START_NODES) break;
    }
    return [...nodes.values()];
  }

  private incidentEdges(
    nodeId: string,
    context: RetrievalContext,
  ): Promise<GraphEdge[]> {
    let pending = context.incidentEdgesCache.get(nodeId);
    if (!pending) {
      pending = (async () => {
        const edgeIds = await this.indexKeys(
          this.nodeEdgesScope(nodeId, context),
        );
        const edges: GraphEdge[] = [];
        for (const edgeId of edgeIds.keys) {
          const edge = await this.loadEdge(edgeId, context);
          if (
            edge &&
            (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId)
          ) {
            edges.push(edge);
          }
        }
        return edges;
      })();
      context.incidentEdgesCache.set(nodeId, pending);
    }
    return pending;
  }

  async searchByEntities(
    entityNames: string[],
    maxDepth = 2,
    maxResults = 20,
  ): Promise<GraphRetrievalResult[]> {
    const context = await this.createContext();
    const matchingNodes = await this.findNodesByEntities(entityNames, context);

    if (matchingNodes.length === 0 || maxResults <= 0) return [];

    const results = new Map<string, GraphRetrievalResult>();
    const keepBest = (candidate: GraphRetrievalResult): void => {
      const existing = results.get(candidate.obsId);
      if (!existing || candidate.score > existing.score) {
        results.set(candidate.obsId, candidate);
      }
    };

    const directCandidates = this.fairSupportCandidates(
      matchingNodes.map((node) => ({
        ids: node.sourceObservationIds,
        owner: node,
      })),
      context,
    );
    for (const { obsId, owner: startNode } of directCandidates) {
        const locator = await this.loadLocator(obsId, context);
        if (!locator) continue;
        keepBest({
          obsId,
          sessionId: locator.sessionId,
          score: 1.0,
          graphContext: `[${startNode.type}] ${startNode.name}`,
          pathLength: 0,
        });
        if (results.size >= maxResults) break;
    }

    if (results.size < maxResults) {
      const pathGroups: Array<{
        ids: string[];
        owner: Array<{ node: GraphNode; edge?: GraphEdge }>;
      }> = [];
      for (const startNode of matchingNodes) {
        const paths = await this.dijkstraTraversal(
          startNode,
          maxDepth,
          maxResults,
          context,
        );
        for (const path of paths) {
          const lastNode = path[path.length - 1].node;
          pathGroups.push({ ids: lastNode.sourceObservationIds, owner: path });
        }
      }
      for (const { obsId, owner: path } of this.fairSupportCandidates(
        pathGroups,
        context,
      )) {
        const locator = await this.loadLocator(obsId, context);
        if (!locator) continue;

        const pathLength = path.length;
        const edgeWeights = path
          .filter((s) => s.edge)
          .map((s) => s.edge!.weight);
        const avgWeight =
          edgeWeights.length > 0
            ? edgeWeights.reduce((a, b) => a + b, 0) / edgeWeights.length
            : 0.5;
        const score = avgWeight * (1 / pathLength);

        keepBest({
          obsId,
          sessionId: locator.sessionId,
          score,
          graphContext: buildGraphContext(path),
          pathLength,
        });
      }
    }

    return [...results.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  async expandFromChunks(
    obsIds: string[],
    maxDepth = 1,
    maxResults = 10,
  ): Promise<GraphRetrievalResult[]> {
    const context = await this.createContext();
    const linkedNodes = await this.findNodesByObservations(obsIds, context);

    const results = new Map<string, GraphRetrievalResult>();
    const excludedObs = new Set(obsIds);

    const pathGroups: Array<{
      ids: string[];
      owner: Array<{ node: GraphNode; edge?: GraphEdge }>;
    }> = [];
    for (const node of linkedNodes) {
      const paths = await this.dijkstraTraversal(
        node,
        maxDepth,
        maxResults,
        context,
      );
      for (const path of paths) {
        const lastNode = path[path.length - 1].node;
        pathGroups.push({ ids: lastNode.sourceObservationIds, owner: path });
      }
    }
    for (const { obsId, owner: path } of this.fairSupportCandidates(
      pathGroups,
      context,
      excludedObs,
    )) {
      const locator = await this.loadLocator(obsId, context);
      if (!locator) continue;

      const pathLength = path.length;
      const score = 0.5 * (1 / (pathLength + 1));

      const candidate = {
        obsId,
        sessionId: locator.sessionId,
        score,
        graphContext: buildGraphContext(path),
        pathLength,
      };
      const existing = results.get(obsId);
      if (!existing || candidate.score > existing.score) {
        results.set(obsId, candidate);
      }
    }

    return [...results.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  async temporalQuery(
    entityName: string,
    asOf?: string,
  ): Promise<{
    entity: GraphNode | null;
    currentState: GraphEdge[];
    history: GraphEdge[];
    migrationStatus?: string;
  }> {
    const context = await this.createContext();
    const exact = await this.findExactNodes([entityName], context);
    if (context.generation && exact.nodes.length === 0) {
      return {
        entity: null,
        currentState: [],
        history: [],
        migrationStatus:
          `Active derived-index generation ${context.generation} has no valid ` +
          `exact-name membership for "${entityName}"; inspect v2 migration status`,
      };
    }
    if (!context.generation && exact.nodes.length === 0 && exact.exhausted) {
      return {
        entity: null,
        currentState: [],
        history: [],
        migrationStatus:
          "Legacy exact-name scan exhausted before a definitive match; " +
          "build and activate derived-index v2",
      };
    }
    const partial = exact.nodes.length === 0
      ? await this.findNodesByEntities([entityName], context)
      : [];
    const entity = exact.nodes[0] ?? partial[0] ?? null;
    if (!entity) return { entity: null, currentState: [], history: [] };

    const relatedEdges = await this.incidentEdges(entity.id, context);

    if (!asOf) {
      const latestEdges = this.getLatestEdges(relatedEdges);
      const historicalEdges = relatedEdges.filter(
        (e) => !latestEdges.some((le) => le.id === e.id),
      );
      return { entity, currentState: latestEdges, history: historicalEdges };
    }

    const asOfDate = new Date(asOf).getTime();
    const validEdges = relatedEdges.filter((e) => {
      const commitDate = new Date(e.tcommit || e.createdAt).getTime();
      if (commitDate > asOfDate) return false;
      if (e.tvalid) {
        const validDate = new Date(e.tvalid).getTime();
        if (validDate > asOfDate) return false;
      }
      if (e.tvalidEnd) {
        const endDate = new Date(e.tvalidEnd).getTime();
        if (endDate < asOfDate) return false;
      }
      return true;
    });

    return {
      entity,
      currentState: this.getLatestEdges(validEdges),
      history: validEdges,
    };
  }

  private getLatestEdges(edges: GraphEdge[]): GraphEdge[] {
    const byKey = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      const key = `${e.sourceNodeId}|${e.targetNodeId}|${e.type}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(e);
    }

    const latest: GraphEdge[] = [];
    for (const group of byKey.values()) {
      if (group.length === 0) continue;
      group.sort(
        (a, b) =>
          new Date(b.tcommit || b.createdAt).getTime() -
          new Date(a.tcommit || a.createdAt).getTime(),
      );
      const newest = group.find((e) => e.isLatest !== false) || group[0];
      latest.push(newest);
    }
    return latest;
  }

  // Weighted shortest-path traversal over bounded per-node adjacency pages.
  // Dijkstra uses cost = 1/weight, so stronger relationships remain cheaper.
  private async dijkstraTraversal(
    startNode: GraphNode,
    maxDepth: number,
    maxResults: number,
    context: RetrievalContext,
  ): Promise<Array<Array<{ node: GraphNode; edge?: GraphEdge }>>> {
    const traversalNodeIds = new Set<string>([startNode.id]);
    const traversalCap = Math.min(
      MAX_TRAVERSAL_NODES,
      Math.max(64, maxResults * 8),
    );

    const stateKey = (nodeId: string, depth: number): string => `${nodeId}\0${depth}`;
    const dist = new Map<string, number>();
    const pathTo = new Map<string, Array<{ node: GraphNode; edge?: GraphEdge }>>();
    const bestNodeCost = new Map<string, number>();
    const bestNodePath = new Map<
      string,
      Array<{ node: GraphNode; edge?: GraphEdge }>
    >();
    const startKey = stateKey(startNode.id, 0);
    dist.set(startKey, 0);
    pathTo.set(startKey, [{ node: startNode }]);

    const heap = new MinHeap<{ nodeId: string; depth: number; cost: number }>(
      (a, b) => a.cost - b.cost,
    );
    heap.push({ nodeId: startNode.id, depth: 0, cost: 0 });

    while (heap.size() > 0) {
      const { nodeId, depth, cost } = heap.pop()!;
      const currentKey = stateKey(nodeId, depth);
      // Skip stale heap entries (cost beaten by a later push).
      if (cost > (dist.get(currentKey) ?? Infinity)) continue;
      if (nodeId !== startNode.id && cost < (bestNodeCost.get(nodeId) ?? Infinity)) {
        bestNodeCost.set(nodeId, cost);
        bestNodePath.set(nodeId, pathTo.get(currentKey)!);
      }
      if (depth >= maxDepth) continue;

      const edges = await this.incidentEdges(nodeId, context);
      for (const edge of edges) {
        const neighborId =
          edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
        if (
          !traversalNodeIds.has(neighborId) &&
          traversalNodeIds.size >= traversalCap
        ) continue;
        const nextNode = await this.loadNode(neighborId, context);
        if (!nextNode) continue;
        traversalNodeIds.add(neighborId);
        // Clamp weight to avoid division-by-zero on malformed edges;
        // 0.01 is below the documented 0.1 floor.
        const edgeCost = 1 / Math.max(edge.weight, 0.01);
        const newCost = cost + edgeCost;
        const nextDepth = depth + 1;
        const nextKey = stateKey(neighborId, nextDepth);
        if (newCost < (dist.get(nextKey) ?? Infinity)) {
          dist.set(nextKey, newCost);
          pathTo.set(nextKey, [
            ...pathTo.get(currentKey)!,
            { node: nextNode, edge },
          ]);
          heap.push({ nodeId: neighborId, depth: nextDepth, cost: newCost });
        }
      }
    }

    // The start node is omitted because callers score its observations
    // directly at 1.0 rather than through path-weight scoring.
    return Array.from(bestNodePath.values());
  }
}

// Minimal binary min-heap. Pulled inline so graph-retrieval doesn't
// take a new dependency for the perf-critical inner loop of #328.
// Comparator returns negative when `a` should pop before `b`.
class MinHeap<T> {
  private heap: T[] = [];

  constructor(private compare: (a: T, b: T) => number) {}

  size(): number {
    return this.heap.length;
  }

  push(value: T): void {
    this.heap.push(value);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.heap[i], this.heap[parent]) < 0) {
        [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
        i = parent;
      } else break;
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < n && this.compare(this.heap[left], this.heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < n && this.compare(this.heap[right], this.heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}
