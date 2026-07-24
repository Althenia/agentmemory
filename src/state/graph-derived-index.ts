import { createHash, randomUUID } from "node:crypto";
import type { GraphEdge, GraphNode } from "../types.js";
import type { StateKV } from "./kv.js";
import { withKeyedLock } from "./keyed-mutex.js";
import { KV } from "./schema.js";

const GRAPH_INDEX_PREFIX = "mem:graph:index:";
const GRAPH_INDEX_V2_PREFIX = `${GRAPH_INDEX_PREFIX}v2:`;
const MAX_INDEXED_SUPPORT_IDS = 32;
const GENERATION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const RECOVERY_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DERIVED_INDEX_LIFECYCLE_LOCK = "derived-index-v2-lifecycle";

export const DERIVED_INDEX_ACTIVE_KEY = "active";
export const DERIVED_INDEX_MAINTENANCE_KEY = "maintenance";
export const DERIVED_INDEX_PAGE_BUDGET_MS = 175_000;
const DERIVED_INDEX_KINDS = [
  "graph-nodes",
  "graph-edges",
  "memories",
  "observations",
] as const;

export type DerivedIndexGenerationKind = typeof DERIVED_INDEX_KINDS[number];

export interface DerivedIndexKindProgress {
  count: number;
  checksum: string;
  complete: boolean;
  cursor?: string;
  sessionCursor?: string;
  currentSessionId?: string;
  observationCursor?: string;
}

export interface DerivedIndexGenerationMetadata {
  version: 2;
  generation: string;
  status: "building" | "complete";
  createdAt: string;
  updatedAt: string;
  totalCount: number;
  progress: Record<DerivedIndexGenerationKind, DerivedIndexKindProgress>;
  finalChecksum?: string;
}

export interface ActiveDerivedIndexGeneration {
  version: 2;
  generation: string;
  previousGeneration?: string;
  activatedAt: string;
  checksum: string;
}

export interface DerivedIndexMaintenanceMarker {
  version: 2;
  operation: "rebuild" | "rollback";
  generation: string;
  ownerToken: string;
  startedAt: string;
}

export interface DerivedIndexInflightMutation {
  version: 2;
  ownerToken: string;
  operationToken: string;
  operation: "canonical-mutation";
  scope: string;
  key: string;
  startedAt: string;
  expiresAt: string;
}

export interface DerivedIndexRecoveryOptions {
  minimumAgeSeconds: number;
  expectedOwnerToken?: string;
  expectedOperationToken?: string;
  expectedMarkerToken?: string;
}

export interface DerivedIndexRecoveryResult {
  recoveredInflight: number;
  removedMaintenance: boolean;
}

export interface DerivedIndexGenerationOptions {
  generation: string;
}

export interface DerivedIndexPageOptions extends DerivedIndexGenerationOptions {
  limit?: number;
}

export interface DerivedIndexStatusOptions {
  generation?: string;
}

export interface DerivedIndexPageResult {
  processed: number;
  complete: boolean;
  metadata: DerivedIndexGenerationMetadata;
}

export class DerivedIndexLifecycleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerivedIndexLifecycleConflictError";
  }
}

export interface SupportLocator {
  id: string;
  kind: "observation" | "memory";
  sessionId: string;
  project?: string;
  agentId?: string;
}

export function normalizeGraphTerm(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

export function graphNameTerms(value: string): string[] {
  const normalized = normalizeGraphTerm(value);
  if (!normalized) return [];
  return [
    ...new Set([
      normalized,
      ...normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean),
    ]),
  ].slice(0, 16);
}

export function graphNameScope(term: string): string {
  const digest = createHash("sha256").update(term).digest("hex").slice(0, 32);
  return `${GRAPH_INDEX_PREFIX}name:${digest}`;
}

function generationPrefix(generation: string): string {
  return `${GRAPH_INDEX_V2_PREFIX}${encodeURIComponent(generation)}:`;
}

export function graphGenerationNameScope(
  term: string,
  generation: string,
): string {
  const digest = createHash("sha256").update(term).digest("hex").slice(0, 32);
  return `${generationPrefix(generation)}name:${digest}`;
}

export function graphNameScopes(name: string): string[] {
  return graphNameTerms(name).map(graphNameScope);
}

export function graphExactNameScope(name: string): string {
  const digest = createHash("sha256")
    .update(normalizeGraphTerm(name))
    .digest("hex")
    .slice(0, 32);
  return `${GRAPH_INDEX_PREFIX}exact-name:${digest}`;
}

export function graphGenerationExactNameScope(
  name: string,
  generation: string,
): string {
  const digest = createHash("sha256")
    .update(normalizeGraphTerm(name))
    .digest("hex")
    .slice(0, 32);
  return `${generationPrefix(generation)}exact-name:${digest}`;
}

export function graphNodeEdgesScope(nodeId: string): string {
  return `${GRAPH_INDEX_PREFIX}node-edges:${encodeURIComponent(nodeId)}`;
}

export function graphGenerationNodeEdgesScope(
  nodeId: string,
  generation: string,
): string {
  return `${generationPrefix(generation)}node-edges:${encodeURIComponent(nodeId)}`;
}

export function graphObservationNodesScope(obsId: string): string {
  return `${GRAPH_INDEX_PREFIX}observation-nodes:${encodeURIComponent(obsId)}`;
}

export function graphGenerationObservationNodesScope(
  obsId: string,
  generation: string,
): string {
  return `${generationPrefix(generation)}observation-nodes:${encodeURIComponent(obsId)}`;
}

export function graphGenerationSupportLocatorsScope(generation: string): string {
  return `${generationPrefix(generation)}support-locators`;
}

export function isGraphDerivedScope(scope: string): boolean {
  return scope.startsWith(GRAPH_INDEX_PREFIX);
}

export function retainedGraphSupportIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const newest: string[] = [];
  for (let index = ids.length - 1; index >= 0; index--) {
    const id = ids[index];
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    newest.push(id);
    if (newest.length >= MAX_INDEXED_SUPPORT_IDS) break;
  }
  return newest.reverse();
}

export function graphNodeIndexEntries(
  node: GraphNode,
  generation?: string,
): Array<{ scope: string; key: string }> {
  if (
    !node ||
    node.stale ||
    typeof node.id !== "string" ||
    typeof node.name !== "string"
  ) return [];
  const normalizedName = normalizeGraphTerm(node.name);
  const observationIds = retainedGraphSupportIds(node.sourceObservationIds);
  const nameScope = (term: string): string => generation
    ? graphGenerationNameScope(term, generation)
    : graphNameScope(term);
  const exactNameScope = generation
    ? graphGenerationExactNameScope(normalizedName, generation)
    : graphExactNameScope(normalizedName);
  const observationScope = (obsId: string): string => generation
    ? graphGenerationObservationNodesScope(obsId, generation)
    : graphObservationNodesScope(obsId);
  return [
    ...(normalizedName
      ? [{ scope: exactNameScope, key: node.id }]
      : []),
    ...graphNameTerms(node.name).map((term) => ({
      scope: nameScope(term),
      key: node.id,
    })),
    ...observationIds.map((obsId) => ({
      scope: observationScope(obsId),
      key: node.id,
    })),
  ];
}

export function graphEdgeIndexEntries(
  edge: GraphEdge,
  generation?: string,
): Array<{ scope: string; key: string }> {
  if (
    !edge ||
    edge.stale ||
    typeof edge.id !== "string" ||
    typeof edge.sourceNodeId !== "string" ||
    typeof edge.targetNodeId !== "string"
  ) return [];
  return [
    {
      scope: generation
        ? graphGenerationNodeEdgesScope(edge.sourceNodeId, generation)
        : graphNodeEdgesScope(edge.sourceNodeId),
      key: edge.id,
    },
    {
      scope: generation
        ? graphGenerationNodeEdgesScope(edge.targetNodeId, generation)
        : graphNodeEdgesScope(edge.targetNodeId),
      key: edge.id,
    },
  ];
}

export type DerivedIndexBackfillKind =
  | "graph-nodes"
  | "graph-edges"
  | "memories"
  | "observations";

export async function backfillDerivedIndexPage(
  kv: StateKV,
  options: {
    kind: DerivedIndexBackfillKind;
    sessionId?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<{ processed: number; nextCursor?: string; complete: boolean }> {
  const scope =
    options.kind === "graph-nodes"
      ? KV.graphNodes
      : options.kind === "graph-edges"
        ? KV.graphEdges
        : options.kind === "memories"
          ? KV.memories
          : options.sessionId
            ? KV.observations(options.sessionId)
            : null;
  if (!scope) throw new Error("sessionId is required for observation backfill");

  const requestedLimit = options.limit ?? 100;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error("limit must be an integer from 1 through 128");
  }
  const limit = Math.min(requestedLimit, 128);
  const page = await kv.listPage<unknown>(scope, {
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    limit,
  });
  for (const item of page.items) {
    await kv.indexDerivedRecord(scope, item.key, item.value);
  }
  return {
    processed: page.items.length,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    complete: page.nextCursor === undefined,
  };
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const EMPTY_KIND_CHECKSUM = checksum("agentmemory:derived-index:v2:empty");

function generationMetadataKey(generation: string): string {
  return `generation:${generation}`;
}

export function derivedIndexRollbackInvalidationKey(generation: string): string {
  return `rollback-invalidated:${generation}`;
}

function requireGeneration(generation: string): void {
  if (!GENERATION_PATTERN.test(generation)) {
    throw new Error(
      "generation must match [A-Za-z0-9._-] and contain 1 through 64 characters",
    );
  }
}

function initialProgress(): Record<
  DerivedIndexGenerationKind,
  DerivedIndexKindProgress
> {
  return {
    "graph-nodes": { count: 0, checksum: EMPTY_KIND_CHECKSUM, complete: false },
    "graph-edges": { count: 0, checksum: EMPTY_KIND_CHECKSUM, complete: false },
    memories: { count: 0, checksum: EMPTY_KIND_CHECKSUM, complete: false },
    observations: { count: 0, checksum: EMPTY_KIND_CHECKSUM, complete: false },
  };
}

function isMaintenanceMarker(
  value: unknown,
): value is DerivedIndexMaintenanceMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<DerivedIndexMaintenanceMarker>;
  return marker.version === 2 &&
    (marker.operation === "rebuild" || marker.operation === "rollback") &&
    typeof marker.generation === "string" &&
    typeof marker.ownerToken === "string" &&
    marker.ownerToken.length > 0 &&
    typeof marker.startedAt === "string";
}

function isInflightMutation(
  value: unknown,
): value is DerivedIndexInflightMutation {
  if (!value || typeof value !== "object") return false;
  const mutation = value as Partial<DerivedIndexInflightMutation>;
  return mutation.version === 2 &&
    mutation.operation === "canonical-mutation" &&
    typeof mutation.ownerToken === "string" &&
    mutation.ownerToken.length > 0 &&
    typeof mutation.operationToken === "string" &&
    mutation.operationToken.length > 0 &&
    typeof mutation.scope === "string" &&
    typeof mutation.key === "string" &&
    typeof mutation.startedAt === "string" &&
    typeof mutation.expiresAt === "string";
}

export function isActiveDerivedIndexGeneration(
  value: unknown,
): value is ActiveDerivedIndexGeneration {
  if (!value || typeof value !== "object") return false;
  const active = value as Partial<ActiveDerivedIndexGeneration>;
  return active.version === 2 &&
    typeof active.generation === "string" &&
    typeof active.activatedAt === "string" &&
    typeof active.checksum === "string" &&
    (active.previousGeneration === undefined ||
      typeof active.previousGeneration === "string");
}

function isGenerationMetadata(
  value: unknown,
): value is DerivedIndexGenerationMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<DerivedIndexGenerationMetadata>;
  if (
    metadata.version !== 2 ||
    typeof metadata.generation !== "string" ||
    (metadata.status !== "building" && metadata.status !== "complete") ||
    typeof metadata.createdAt !== "string" ||
    typeof metadata.updatedAt !== "string" ||
    !Number.isInteger(metadata.totalCount) ||
    !metadata.progress ||
    typeof metadata.progress !== "object"
  ) return false;
  return DERIVED_INDEX_KINDS.every((kind) => {
    const progress = metadata.progress?.[kind];
    return !!progress &&
      Number.isInteger(progress.count) &&
      progress.count >= 0 &&
      typeof progress.checksum === "string" &&
      typeof progress.complete === "boolean";
  });
}

export async function getActiveDerivedIndexGeneration(
  kv: StateKV,
): Promise<ActiveDerivedIndexGeneration | null> {
  const active = await kv.get<unknown>(
    KV.graphDerivedMetadata,
    DERIVED_INDEX_ACTIVE_KEY,
  );
  if (active === null) return null;
  if (!isActiveDerivedIndexGeneration(active)) {
    throw new Error("invalid active derived-index generation metadata");
  }
  return active;
}

export async function getDerivedIndexMaintenanceMarker(
  kv: StateKV,
): Promise<DerivedIndexMaintenanceMarker | null> {
  const marker = await kv.get<unknown>(
    KV.graphDerivedMetadata,
    DERIVED_INDEX_MAINTENANCE_KEY,
  );
  if (marker === null) return null;
  if (!isMaintenanceMarker(marker)) {
    throw new Error("invalid derived-index maintenance metadata");
  }
  return marker;
}

function withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
  return withKeyedLock(DERIVED_INDEX_LIFECYCLE_LOCK, operation);
}

function sameMaintenanceOwner(
  current: DerivedIndexMaintenanceMarker | null,
  expected: DerivedIndexMaintenanceMarker,
): boolean {
  return current?.operation === expected.operation &&
    current.generation === expected.generation &&
    current.ownerToken === expected.ownerToken;
}

async function requireMaintenanceOwnership(
  kv: StateKV,
  expected: DerivedIndexMaintenanceMarker,
): Promise<void> {
  const current = await getDerivedIndexMaintenanceMarker(kv);
  if (!sameMaintenanceOwner(current, expected)) {
    throw new DerivedIndexLifecycleConflictError(
      "derived-index maintenance marker ownership changed",
    );
  }
}

async function deleteOwnedMaintenanceMarker(
  kv: StateKV,
  expected: DerivedIndexMaintenanceMarker,
): Promise<void> {
  await requireMaintenanceOwnership(kv, expected);
  await kv.delete(KV.graphDerivedMetadata, DERIVED_INDEX_MAINTENANCE_KEY);
}

async function readGenerationMetadata(
  kv: StateKV,
  generation: string,
): Promise<DerivedIndexGenerationMetadata | null> {
  const metadata = await kv.get<unknown>(
    KV.graphDerivedMetadata,
    generationMetadataKey(generation),
  );
  if (metadata === null) return null;
  if (!isGenerationMetadata(metadata) || metadata.generation !== generation) {
    throw new Error(`invalid metadata for derived-index generation ${generation}`);
  }
  return metadata;
}

async function hasInFlightMutation(kv: StateKV): Promise<boolean> {
  const page = await kv.listPage<unknown>(KV.graphDerivedInflight, { limit: 1 });
  return page.items.length > 0;
}

async function listInflightMutations(
  kv: StateKV,
): Promise<Array<{ rowKey: string; mutation: DerivedIndexInflightMutation }>> {
  const mutations: Array<{
    rowKey: string;
    mutation: DerivedIndexInflightMutation;
  }> = [];
  let cursor: string | undefined;
  do {
    const page = await kv.listPage<unknown>(KV.graphDerivedInflight, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit: 128,
    });
    for (const item of page.items) {
      if (!isInflightMutation(item.value)) {
        throw new Error(`invalid derived-index inflight metadata for ${item.key}`);
      }
      mutations.push({ rowKey: item.key, mutation: item.value });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return mutations;
}

function requireRecoveryToken(value: string | undefined, field: string): void {
  if (value !== undefined && !RECOVERY_TOKEN_PATTERN.test(value)) {
    throw new Error(`${field} must contain 1 through 128 token characters`);
  }
}

function persistedTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`invalid ${field} in derived-index lifecycle metadata`);
  }
  return timestamp;
}

function requireRecoverableInflight(
  kv: StateKV,
  mutation: DerivedIndexInflightMutation,
  options: DerivedIndexRecoveryOptions,
  now: number,
): void {
  if (mutation.ownerToken !== options.expectedOwnerToken) {
    throw new DerivedIndexLifecycleConflictError(
      "derived-index inflight owner token does not match",
    );
  }
  if (mutation.operationToken !== options.expectedOperationToken) {
    throw new DerivedIndexLifecycleConflictError(
      "derived-index inflight operation token does not match",
    );
  }
  if (kv.isInflightOperationLive(mutation.operationToken)) {
    throw new DerivedIndexLifecycleConflictError(
      "derived-index inflight operation is still live in this process",
    );
  }
  if (persistedTimestamp(mutation.expiresAt, "inflight expiresAt") > now) {
    throw new DerivedIndexLifecycleConflictError(
      "derived-index inflight operation is not expired",
    );
  }
  const startedAt = persistedTimestamp(mutation.startedAt, "inflight startedAt");
  if (now - startedAt < options.minimumAgeSeconds * 1000) {
    throw new DerivedIndexLifecycleConflictError(
      "derived-index inflight operation is younger than minimumAgeSeconds",
    );
  }
}

function advanceChecksum(
  previous: string,
  kind: DerivedIndexGenerationKind,
  scope: string,
  key: string,
  value: unknown,
): string {
  return checksum(
    `${previous}\0${kind}\0${scope}\0${key}\0${JSON.stringify(value) ?? "null"}`,
  );
}

function completeChecksum(
  progress: Record<DerivedIndexGenerationKind, DerivedIndexKindProgress>,
): string {
  return checksum(
    DERIVED_INDEX_KINDS.map((kind) =>
      `${kind}:${progress[kind].count}:${progress[kind].checksum}`
    ).join("\0"),
  );
}

function completedMetadata(
  metadata: DerivedIndexGenerationMetadata,
): boolean {
  if (metadata.status !== "complete" || !metadata.finalChecksum) return false;
  if (!DERIVED_INDEX_KINDS.every((kind) => metadata.progress[kind].complete)) {
    return false;
  }
  const totalCount = DERIVED_INDEX_KINDS.reduce(
    (total, kind) => total + metadata.progress[kind].count,
    0,
  );
  return totalCount === metadata.totalCount &&
    metadata.finalChecksum === completeChecksum(metadata.progress);
}

async function beginDerivedIndexGenerationUnlocked(
  kv: StateKV,
  options: DerivedIndexGenerationOptions,
): Promise<DerivedIndexGenerationMetadata> {
  requireGeneration(options.generation);
  const now = new Date().toISOString();
  const existingMarker = await getDerivedIndexMaintenanceMarker(kv);
  if (
    existingMarker &&
    (existingMarker.operation !== "rebuild" ||
      existingMarker.generation !== options.generation)
  ) {
    throw new DerivedIndexLifecycleConflictError(
      `derived-index maintenance is already active for ${existingMarker.generation}`,
    );
  }
  let installedMarker = false;
  const marker: DerivedIndexMaintenanceMarker = existingMarker ?? {
    version: 2,
    operation: "rebuild",
    generation: options.generation,
    ownerToken: randomUUID(),
    startedAt: now,
  };
  if (!existingMarker) {
    await kv.set<DerivedIndexMaintenanceMarker>(
      KV.graphDerivedMetadata,
      DERIVED_INDEX_MAINTENANCE_KEY,
      marker,
    );
    installedMarker = true;
  }
  try {
    await requireMaintenanceOwnership(kv, marker);
    if (await hasInFlightMutation(kv)) {
      throw new DerivedIndexLifecycleConflictError(
        "derived-index maintenance is active; wait for in-flight canonical mutations to drain",
      );
    }
    const existing = await readGenerationMetadata(kv, options.generation);
    if (existing) return existing;
    const metadata: DerivedIndexGenerationMetadata = {
      version: 2,
      generation: options.generation,
      status: "building",
      createdAt: now,
      updatedAt: now,
      totalCount: 0,
      progress: initialProgress(),
    };
    await requireMaintenanceOwnership(kv, marker);
    await kv.set(
      KV.graphDerivedMetadata,
      generationMetadataKey(options.generation),
      metadata,
    );
    return metadata;
  } catch (err) {
    if (installedMarker) await deleteOwnedMaintenanceMarker(kv, marker);
    throw err;
  }
}

export function beginDerivedIndexGeneration(
  kv: StateKV,
  options: DerivedIndexGenerationOptions,
): Promise<DerivedIndexGenerationMetadata> {
  return withLifecycleLock(() => beginDerivedIndexGenerationUnlocked(kv, options));
}

function nextIncompleteKind(
  metadata: DerivedIndexGenerationMetadata,
): DerivedIndexGenerationKind | null {
  return DERIVED_INDEX_KINDS.find(
    (kind) => !metadata.progress[kind].complete,
  ) ?? null;
}

async function rebuildSimpleKindPage(
  kv: StateKV,
  metadata: DerivedIndexGenerationMetadata,
  kind: Exclude<DerivedIndexGenerationKind, "observations">,
  limit: number,
): Promise<{ processed: number; progress: DerivedIndexKindProgress }> {
  const scope = kind === "graph-nodes"
    ? KV.graphNodes
    : kind === "graph-edges"
      ? KV.graphEdges
      : KV.memories;
  const current = metadata.progress[kind];
  const page = await kv.listPage<unknown>(scope, {
    ...(current.cursor !== undefined ? { cursor: current.cursor } : {}),
    limit,
  });
  let nextChecksum = current.checksum;
  for (const item of page.items) {
    await kv.indexDerivedRecord(scope, item.key, item.value, {
      generation: metadata.generation,
    });
    nextChecksum = advanceChecksum(
      nextChecksum,
      kind,
      scope,
      item.key,
      item.value,
    );
  }
  return {
    processed: page.items.length,
    progress: {
      count: current.count + page.items.length,
      checksum: nextChecksum,
      complete: page.nextCursor === undefined,
      ...(page.nextCursor !== undefined ? { cursor: page.nextCursor } : {}),
    },
  };
}

async function rebuildObservationPage(
  kv: StateKV,
  metadata: DerivedIndexGenerationMetadata,
  limit: number,
): Promise<{ processed: number; progress: DerivedIndexKindProgress }> {
  const current = metadata.progress.observations;
  let sessionId = current.currentSessionId;
  if (!sessionId) {
    const sessionPage = await kv.listPage<unknown>(KV.sessions, {
      ...(current.sessionCursor !== undefined
        ? { cursor: current.sessionCursor }
        : {}),
      limit: 1,
    });
    const session = sessionPage.items[0];
    if (!session) {
      return {
        processed: 0,
        progress: { ...current, complete: true },
      };
    }
    sessionId = session.key;
  }

  const scope = KV.observations(sessionId);
  const page = await kv.listPage<unknown>(scope, {
    ...(current.currentSessionId === sessionId &&
        current.observationCursor !== undefined
      ? { cursor: current.observationCursor }
      : {}),
    limit,
  });
  let nextChecksum = current.checksum;
  for (const item of page.items) {
    await kv.indexDerivedRecord(scope, item.key, item.value, {
      generation: metadata.generation,
    });
    nextChecksum = advanceChecksum(
      nextChecksum,
      "observations",
      scope,
      item.key,
      item.value,
    );
  }
  if (page.nextCursor !== undefined) {
    return {
      processed: page.items.length,
      progress: {
        ...current,
        count: current.count + page.items.length,
        checksum: nextChecksum,
        complete: false,
        currentSessionId: sessionId,
        observationCursor: page.nextCursor,
      },
    };
  }
  const {
    currentSessionId: _currentSessionId,
    observationCursor: _observationCursor,
    ...withoutCurrentSession
  } = current;
  return {
    processed: page.items.length,
    progress: {
      ...withoutCurrentSession,
      count: current.count + page.items.length,
      checksum: nextChecksum,
      complete: false,
      sessionCursor: sessionId,
    },
  };
}

async function rebuildDerivedIndexGenerationPageUnlocked(
  kv: StateKV,
  options: DerivedIndexPageOptions,
): Promise<DerivedIndexPageResult> {
  requireGeneration(options.generation);
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) {
    throw new Error("limit must be an integer from 1 through 128");
  }
  const marker = await getDerivedIndexMaintenanceMarker(kv);
  if (
    !marker ||
    marker.operation !== "rebuild" ||
    marker.generation !== options.generation
  ) {
    throw new DerivedIndexLifecycleConflictError(
      `generation ${options.generation} requires its active rebuild maintenance marker`,
    );
  }
  await requireMaintenanceOwnership(kv, marker);
  if (await hasInFlightMutation(kv)) {
    throw new DerivedIndexLifecycleConflictError(
      "cannot rebuild while canonical mutations are in-flight",
    );
  }
  const metadata = await readGenerationMetadata(kv, options.generation);
  if (!metadata) {
    throw new DerivedIndexLifecycleConflictError(
      `unknown generation ${options.generation}`,
    );
  }
  if (metadata.status === "complete") {
    if (!completedMetadata(metadata)) {
      throw new Error(`generation ${options.generation} has invalid completeness metadata`);
    }
    return { processed: 0, complete: true, metadata };
  }
  const kind = nextIncompleteKind(metadata);
  if (!kind) throw new Error(`generation ${options.generation} has invalid progress`);
  const result = kind === "observations"
    ? await rebuildObservationPage(kv, metadata, limit)
    : await rebuildSimpleKindPage(kv, metadata, kind, limit);
  const progress = {
    ...metadata.progress,
    [kind]: result.progress,
  };
  const allComplete = DERIVED_INDEX_KINDS.every(
    (progressKind) => progress[progressKind].complete,
  );
  const totalCount = DERIVED_INDEX_KINDS.reduce(
    (total, progressKind) => total + progress[progressKind].count,
    0,
  );
  const nextMetadata: DerivedIndexGenerationMetadata = {
    ...metadata,
    status: allComplete ? "complete" : "building",
    updatedAt: new Date().toISOString(),
    totalCount,
    progress,
    ...(allComplete ? { finalChecksum: completeChecksum(progress) } : {}),
  };
  await requireMaintenanceOwnership(kv, marker);
  await kv.set(
    KV.graphDerivedMetadata,
    generationMetadataKey(options.generation),
    nextMetadata,
  );
  return {
    processed: result.processed,
    complete: allComplete,
    metadata: nextMetadata,
  };
}

export function rebuildDerivedIndexGenerationPage(
  kv: StateKV,
  options: DerivedIndexPageOptions,
): Promise<DerivedIndexPageResult> {
  const operation = withLifecycleLock(() =>
    rebuildDerivedIndexGenerationPageUnlocked(kv, options)
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(
        new Error(
          `derived-index page exceeded ${DERIVED_INDEX_PAGE_BUDGET_MS}ms budget`,
        ),
      ),
      DERIVED_INDEX_PAGE_BUDGET_MS,
    );
    operation.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function getDerivedIndexGenerationStatusUnlocked(
  kv: StateKV,
  options: DerivedIndexStatusOptions = {},
): Promise<{
  active: ActiveDerivedIndexGeneration | null;
  maintenance: DerivedIndexMaintenanceMarker | null;
  generation: DerivedIndexGenerationMetadata | null;
  inFlight: boolean;
  inFlightMutations: DerivedIndexInflightMutation[];
  rollbackInvalidated: boolean;
}> {
  if (options.generation !== undefined) requireGeneration(options.generation);
  const active = await getActiveDerivedIndexGeneration(kv);
  const maintenance = await getDerivedIndexMaintenanceMarker(kv);
  const generation = options.generation ??
    maintenance?.generation ??
    active?.generation;
  const rollbackInvalidation = generation
    ? await kv.get<unknown>(
        KV.graphDerivedMetadata,
        derivedIndexRollbackInvalidationKey(generation),
      )
    : null;
  const inFlightMutations = (await listInflightMutations(kv))
    .map(({ mutation }) => mutation);
  return {
    active,
    maintenance,
    generation: generation
      ? await readGenerationMetadata(kv, generation)
      : null,
    inFlight: inFlightMutations.length > 0,
    inFlightMutations,
    rollbackInvalidated: rollbackInvalidation !== null,
  };
}

export function getDerivedIndexGenerationStatus(
  kv: StateKV,
  options: DerivedIndexStatusOptions = {},
): Promise<{
  active: ActiveDerivedIndexGeneration | null;
  maintenance: DerivedIndexMaintenanceMarker | null;
  generation: DerivedIndexGenerationMetadata | null;
  inFlight: boolean;
  inFlightMutations: DerivedIndexInflightMutation[];
  rollbackInvalidated: boolean;
}> {
  return withLifecycleLock(() =>
    getDerivedIndexGenerationStatusUnlocked(kv, options)
  );
}

async function recoverDerivedIndexLifecycleUnlocked(
  kv: StateKV,
  options: DerivedIndexRecoveryOptions,
): Promise<DerivedIndexRecoveryResult> {
  if (!Number.isInteger(options.minimumAgeSeconds) || options.minimumAgeSeconds < 1) {
    throw new Error("minimumAgeSeconds must be a positive integer");
  }
  requireRecoveryToken(options.expectedOwnerToken, "expectedOwnerToken");
  requireRecoveryToken(options.expectedOperationToken, "expectedOperationToken");
  requireRecoveryToken(options.expectedMarkerToken, "expectedMarkerToken");
  const hasOwner = options.expectedOwnerToken !== undefined;
  const hasOperation = options.expectedOperationToken !== undefined;
  if (hasOwner !== hasOperation) {
    throw new Error(
      "expectedOwnerToken and expectedOperationToken must be provided together",
    );
  }
  if (!hasOwner && options.expectedMarkerToken === undefined) {
    throw new Error(
      "recovery requires an inflight owner/operation token pair or expectedMarkerToken",
    );
  }

  const now = Date.now();
  const targetRowKey = hasOperation
    ? `mutation-${options.expectedOperationToken}`
    : undefined;
  let targetMutation: DerivedIndexInflightMutation | null = null;
  if (targetRowKey) {
    const value = await kv.get<unknown>(KV.graphDerivedInflight, targetRowKey);
    if (value === null) {
      throw new DerivedIndexLifecycleConflictError(
        "derived-index inflight operation was not found",
      );
    }
    if (!isInflightMutation(value)) {
      throw new Error(`invalid derived-index inflight metadata for ${targetRowKey}`);
    }
    requireRecoverableInflight(kv, value, options, now);
    targetMutation = value;
  }

  let marker: DerivedIndexMaintenanceMarker | null = null;
  if (options.expectedMarkerToken !== undefined) {
    marker = await getDerivedIndexMaintenanceMarker(kv);
    if (!marker || marker.ownerToken !== options.expectedMarkerToken) {
      throw new DerivedIndexLifecycleConflictError(
        "derived-index maintenance marker token does not match",
      );
    }
    const markerStartedAt = persistedTimestamp(
      marker.startedAt,
      "maintenance startedAt",
    );
    if (now - markerStartedAt < options.minimumAgeSeconds * 1000) {
      throw new DerivedIndexLifecycleConflictError(
        "derived-index maintenance marker is not old enough to recover",
      );
    }
    const remainingInflight = (await listInflightMutations(kv)).filter(
      ({ rowKey }) => rowKey !== targetRowKey,
    );
    if (remainingInflight.length > 0) {
      throw new DerivedIndexLifecycleConflictError(
        "derived-index maintenance marker is not orphaned while inflight rows remain",
      );
    }
  }

  let recoveredInflight = 0;
  if (targetRowKey && targetMutation) {
    const current = await kv.get<unknown>(KV.graphDerivedInflight, targetRowKey);
    if (!isInflightMutation(current)) {
      throw new DerivedIndexLifecycleConflictError(
        "derived-index inflight operation ownership changed",
      );
    }
    requireRecoverableInflight(kv, current, options, now);
    await kv.delete(KV.graphDerivedInflight, targetRowKey);
    recoveredInflight = 1;
  }

  let removedMaintenance = false;
  if (marker) {
    const current = await getDerivedIndexMaintenanceMarker(kv);
    if (!sameMaintenanceOwner(current, marker)) {
      throw new DerivedIndexLifecycleConflictError(
        "derived-index maintenance marker ownership changed",
      );
    }
    if ((await listInflightMutations(kv)).length > 0) {
      throw new DerivedIndexLifecycleConflictError(
        "derived-index maintenance marker is not orphaned while inflight rows remain",
      );
    }
    await deleteOwnedMaintenanceMarker(kv, marker);
    removedMaintenance = true;
  }

  return { recoveredInflight, removedMaintenance };
}

export function recoverDerivedIndexLifecycle(
  kv: StateKV,
  options: DerivedIndexRecoveryOptions,
): Promise<DerivedIndexRecoveryResult> {
  return withLifecycleLock(() =>
    recoverDerivedIndexLifecycleUnlocked(kv, options)
  );
}

async function activateDerivedIndexGenerationUnlocked(
  kv: StateKV,
  options: DerivedIndexGenerationOptions,
): Promise<ActiveDerivedIndexGeneration> {
  requireGeneration(options.generation);
  const metadata = await readGenerationMetadata(kv, options.generation);
  if (!metadata || metadata.status !== "complete") {
    throw new DerivedIndexLifecycleConflictError(
      `generation ${options.generation} is incomplete`,
    );
  }
  if (!completedMetadata(metadata)) {
    throw new Error(`generation ${options.generation} has invalid completeness metadata`);
  }
  const invalidation = await kv.get<unknown>(
    KV.graphDerivedMetadata,
    derivedIndexRollbackInvalidationKey(options.generation),
  );
  if (invalidation !== null) {
    throw new DerivedIndexLifecycleConflictError(
      `generation ${options.generation} was invalidated by a canonical mutation`,
    );
  }
  const current = await getActiveDerivedIndexGeneration(kv);
  if (current?.generation === options.generation) {
    const marker = await getDerivedIndexMaintenanceMarker(kv);
    if (
      marker?.operation === "rebuild" &&
      marker.generation === options.generation
    ) {
      await requireMaintenanceOwnership(kv, marker);
      if (await hasInFlightMutation(kv)) {
        throw new DerivedIndexLifecycleConflictError(
          "cannot activate while canonical mutations are in-flight",
        );
      }
      await deleteOwnedMaintenanceMarker(kv, marker);
    }
    return current;
  }
  const marker = await getDerivedIndexMaintenanceMarker(kv);
  if (
    !marker ||
    marker.operation !== "rebuild" ||
    marker.generation !== options.generation
  ) {
    throw new DerivedIndexLifecycleConflictError(
      `generation ${options.generation} requires its active rebuild maintenance marker`,
    );
  }
  await requireMaintenanceOwnership(kv, marker);
  if (await hasInFlightMutation(kv)) {
    throw new DerivedIndexLifecycleConflictError(
      "cannot activate while canonical mutations are in-flight",
    );
  }
  const next: ActiveDerivedIndexGeneration = {
    version: 2,
    generation: options.generation,
    ...(current ? { previousGeneration: current.generation } : {}),
    activatedAt: new Date().toISOString(),
    checksum: metadata.finalChecksum!,
  };
  await requireMaintenanceOwnership(kv, marker);
  await kv.set(KV.graphDerivedMetadata, DERIVED_INDEX_ACTIVE_KEY, next);
  await deleteOwnedMaintenanceMarker(kv, marker);
  return next;
}

export function activateDerivedIndexGeneration(
  kv: StateKV,
  options: DerivedIndexGenerationOptions,
): Promise<ActiveDerivedIndexGeneration> {
  return withLifecycleLock(() =>
    activateDerivedIndexGenerationUnlocked(kv, options)
  );
}

async function rollbackDerivedIndexGenerationUnlocked(
  kv: StateKV,
  options: DerivedIndexGenerationOptions,
): Promise<ActiveDerivedIndexGeneration> {
  requireGeneration(options.generation);
  const target = await readGenerationMetadata(kv, options.generation);
  if (!target || target.status !== "complete") {
    throw new DerivedIndexLifecycleConflictError(
      `rollback target ${options.generation} is incomplete`,
    );
  }
  if (!completedMetadata(target)) {
    throw new Error(
      `rollback target ${options.generation} has invalid completeness metadata`,
    );
  }
  const current = await getActiveDerivedIndexGeneration(kv);
  if (!current) {
    throw new DerivedIndexLifecycleConflictError(
      "no active derived-index generation to roll back",
    );
  }
  if (current.generation === options.generation) {
    const marker = await getDerivedIndexMaintenanceMarker(kv);
    if (
      marker?.operation === "rollback" &&
      marker.generation === options.generation
    ) {
      await requireMaintenanceOwnership(kv, marker);
      if (await hasInFlightMutation(kv)) {
        throw new DerivedIndexLifecycleConflictError(
          "cannot roll back while canonical mutations are in-flight",
        );
      }
      await deleteOwnedMaintenanceMarker(kv, marker);
    }
    return current;
  }
  if (current.previousGeneration !== options.generation) {
    throw new DerivedIndexLifecycleConflictError(
      `generation ${options.generation} is not the previous active generation`,
    );
  }
  const invalidation = await kv.get<unknown>(
    KV.graphDerivedMetadata,
    derivedIndexRollbackInvalidationKey(options.generation),
  );
  if (invalidation !== null) {
    throw new DerivedIndexLifecycleConflictError(
      `rollback generation ${options.generation} was invalidated by a canonical mutation`,
    );
  }
  const now = new Date().toISOString();
  const existingMarker = await getDerivedIndexMaintenanceMarker(kv);
  if (
    existingMarker &&
    (existingMarker.operation !== "rollback" ||
      existingMarker.generation !== options.generation)
  ) {
    throw new DerivedIndexLifecycleConflictError(
      `derived-index maintenance is already active for ${existingMarker.generation}`,
    );
  }
  let installedMarker = false;
  const marker: DerivedIndexMaintenanceMarker = existingMarker ?? {
    version: 2,
    operation: "rollback",
    generation: options.generation,
    ownerToken: randomUUID(),
    startedAt: now,
  };
  if (!existingMarker) {
    await kv.set<DerivedIndexMaintenanceMarker>(
      KV.graphDerivedMetadata,
      DERIVED_INDEX_MAINTENANCE_KEY,
      marker,
    );
    installedMarker = true;
  }
  try {
    await requireMaintenanceOwnership(kv, marker);
    if (await hasInFlightMutation(kv)) {
      throw new DerivedIndexLifecycleConflictError(
        "cannot roll back while canonical mutations are in-flight",
      );
    }
    const next: ActiveDerivedIndexGeneration = {
      version: 2,
      generation: options.generation,
      previousGeneration: current.generation,
      activatedAt: now,
      checksum: target.finalChecksum!,
    };
    await requireMaintenanceOwnership(kv, marker);
    await kv.set(KV.graphDerivedMetadata, DERIVED_INDEX_ACTIVE_KEY, next);
    await deleteOwnedMaintenanceMarker(kv, marker);
    return next;
  } catch (err) {
    if (installedMarker) await deleteOwnedMaintenanceMarker(kv, marker);
    throw err;
  }
}

export function rollbackDerivedIndexGeneration(
  kv: StateKV,
  options: DerivedIndexGenerationOptions,
): Promise<ActiveDerivedIndexGeneration> {
  return withLifecycleLock(() =>
    rollbackDerivedIndexGenerationUnlocked(kv, options)
  );
}
