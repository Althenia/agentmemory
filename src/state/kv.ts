import { randomUUID } from 'node:crypto'
import type { ISdk } from 'iii-sdk'
import type { GraphEdge, GraphNode, Memory, Session } from '../types.js'
import { KV } from './schema.js'
import {
  graphEdgeIndexEntries,
  derivedIndexRollbackInvalidationKey,
  graphGenerationSupportLocatorsScope,
  graphNodeIndexEntries,
  isActiveDerivedIndexGeneration,
  isGraphDerivedScope,
  type DerivedIndexInflightMutation,
  type SupportLocator,
} from './graph-derived-index.js'

const INFLIGHT_LEASE_MS = 5 * 60 * 1000
const INFLIGHT_OWNER_TOKEN = randomUUID()
const liveInflightOperations = new Set<string>()

export interface StatePage<T> {
  items: Array<{ key: string; value: T }>
  nextCursor?: string
}

export class StateKV {
  constructor(private sdk: ISdk) {}

  private async getRaw<T = unknown>(scope: string, key: string): Promise<T | null> {
    const value = await this.sdk.trigger<{ scope: string; key: string }, T | null>({
      function_id: 'state::get',
      payload: { scope, key },
    })
    return value ?? null
  }

  private async setRaw<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    return this.sdk.trigger<{ scope: string; key: string; value: T }, T>({
      function_id: 'state::set',
      payload: { scope, key, value },
    })
  }

  private async deleteRaw(scope: string, key: string): Promise<void> {
    return this.sdk.trigger<{ scope: string; key: string }, void>({
      function_id: 'state::delete',
      payload: { scope, key },
    })
  }

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    return this.getRaw<T>(scope, key)
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    if (
      isGraphDerivedScope(scope) ||
      scope === KV.supportLocators
    ) {
      return this.setRaw(scope, key, value)
    }

    if (this.isRelevantCanonicalSource(scope)) {
      return this.withCanonicalMutation(scope, key, async (generation) => {
        if (this.isGraphSource(scope)) {
          await this.applyGraphEntries(
            this.graphEntries(scope, value, generation),
          )
        } else if (this.isLocatorSource(scope)) {
          await this.syncDerivedRecord(scope, key, value, generation)
        }
        return this.setRaw(scope, key, value)
      })
    }

    return this.setRaw(scope, key, value)
  }

  async update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T> {
    const update = (): Promise<T> => this.sdk.trigger<
      { scope: string; key: string; ops: Array<{ type: string; path: string; value?: unknown }> },
      T
    >({
      function_id: 'state::update',
      payload: { scope, key, ops },
    })
    if (!this.isRelevantCanonicalSource(scope)) return update()
    if (this.isGraphSource(scope) || this.isLocatorSource(scope)) {
      throw new Error(
        `StateKV.update cannot maintain derived indexes for canonical scope ${scope}; use set`,
      )
    }
    return this.withCanonicalMutation(scope, key, async () => update())
  }

  async delete(scope: string, key: string): Promise<void> {
    if (!this.isRelevantCanonicalSource(scope)) {
      await this.deleteRaw(scope, key)
      return
    }
    await this.withCanonicalMutation(scope, key, async () => {
      await this.deleteRaw(scope, key)
    })
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    return this.sdk.trigger<{ scope: string }, T[]>({
      function_id: 'state::list',
      payload: { scope },
    })
  }

  async listPage<T = unknown>(
    scope: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<StatePage<T>> {
    const result = await this.sdk.trigger<
      { scope: string; cursor?: string; limit?: number },
      { items: Array<{ key: string; value: T }>; next_cursor?: string }
    >({
      function_id: 'state::list-page',
      payload: { scope, ...options },
    })
    return {
      items: result.items,
      ...(result.next_cursor !== undefined
        ? { nextCursor: result.next_cursor }
        : {}),
    }
  }

  isInflightOperationLive(operationToken: string): boolean {
    return liveInflightOperations.has(operationToken)
  }

  async indexDerivedRecord<T>(
    scope: string,
    key: string,
    value: T,
    options: { generation?: string } = {},
  ): Promise<void> {
    if (!this.isDerivedSource(scope)) {
      throw new Error(`Unsupported derived-index source scope: ${scope}`)
    }
    if (this.isGraphSource(scope)) {
      await this.applyGraphEntries(
        this.graphEntries(scope, value, options.generation),
      )
      return
    }
    await this.syncDerivedRecord(scope, key, value, options.generation)
  }

  private isDerivedSource(scope: string): boolean {
    return scope === KV.graphNodes ||
      scope === KV.graphEdges ||
      scope === KV.memories ||
      scope.startsWith('mem:obs:')
  }

  private isGraphSource(scope: string): boolean {
    return scope === KV.graphNodes || scope === KV.graphEdges
  }

  private isLocatorSource(scope: string): boolean {
    return scope === KV.memories || scope.startsWith('mem:obs:')
  }

  private isRelevantCanonicalSource(scope: string): boolean {
    return this.isGraphSource(scope) ||
      this.isLocatorSource(scope) ||
      scope === KV.sessions
  }

  private graphEntries(
    scope: string,
    value: unknown,
    generation?: string,
  ): Array<{ scope: string; key: string }> {
    if (!value) return []
    return scope === KV.graphNodes
      ? graphNodeIndexEntries(value as GraphNode, generation)
      : graphEdgeIndexEntries(value as GraphEdge, generation)
  }

  private async applyGraphEntries(
    entries: Array<{ scope: string; key: string }>,
  ): Promise<void> {
    for (const entry of entries) {
      await this.setRaw(entry.scope, entry.key, true)
    }
  }

  private async syncDerivedRecord(
    scope: string,
    key: string,
    next: unknown,
    generation?: string,
  ): Promise<void> {
    if (scope === KV.memories) {
      if (!next) return
      const memory = next as Memory
      const locator: SupportLocator = {
        id: key,
        kind: 'memory',
        sessionId: memory.sessionIds?.[0] ?? 'memory',
        ...(memory.project ? { project: memory.project } : {}),
        ...(memory.agentId ? { agentId: memory.agentId } : {}),
      }
      await this.setRaw(
        generation
          ? graphGenerationSupportLocatorsScope(generation)
          : KV.supportLocators,
        key,
        locator,
      )
      return
    }

    if (scope.startsWith('mem:obs:')) {
      if (!next) return
      const observation = next as { id?: string; sessionId?: string; agentId?: string }
      const sessionId = observation.sessionId ?? scope.slice('mem:obs:'.length)
      const session = await this.getRaw<Session>(KV.sessions, sessionId).catch(() => null)
      const agentId = observation.agentId ?? session?.agentId
      const locator: SupportLocator = {
        id: key,
        kind: 'observation',
        sessionId,
        ...(session?.project ? { project: session.project } : {}),
        ...(agentId ? { agentId } : {}),
      }
      await this.setRaw(
        generation
          ? graphGenerationSupportLocatorsScope(generation)
          : KV.supportLocators,
        key,
        locator,
      )
    }
  }

  private async withCanonicalMutation<T>(
    scope: string,
    key: string,
    operation: (generation: string | undefined) => Promise<T>,
  ): Promise<T> {
    const maintenance = await this.getRaw<unknown>(
      KV.graphDerivedMetadata,
      'maintenance',
    )
    if (maintenance !== null) {
      throw new Error('canonical mutation rejected during derived-index maintenance')
    }

    const operationToken = randomUUID()
    const mutationId = `mutation-${operationToken}`
    const startedAt = new Date()
    const mutation: DerivedIndexInflightMutation = {
      version: 2,
      ownerToken: INFLIGHT_OWNER_TOKEN,
      operationToken,
      operation: 'canonical-mutation',
      scope,
      key,
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + INFLIGHT_LEASE_MS).toISOString(),
    }
    let registered = false
    liveInflightOperations.add(operationToken)
    try {
      await this.setRaw(KV.graphDerivedInflight, mutationId, mutation)
      registered = true
      const maintenanceAfterRegistration = await this.getRaw<unknown>(
        KV.graphDerivedMetadata,
        'maintenance',
      )
      if (maintenanceAfterRegistration !== null) {
        throw new Error(
          'canonical mutation rejected during derived-index maintenance',
        )
      }
      const active = await this.getRaw<unknown>(
        KV.graphDerivedMetadata,
        'active',
      )
      if (active !== null && !isActiveDerivedIndexGeneration(active)) {
        throw new Error('invalid active derived-index generation metadata')
      }
      if (active?.previousGeneration) {
        await this.setRaw(
          KV.graphDerivedMetadata,
          derivedIndexRollbackInvalidationKey(active.previousGeneration),
          {
            version: 2,
            generation: active.previousGeneration,
            invalidatedBy: active.generation,
            invalidatedAt: new Date().toISOString(),
          },
        )
      }
      return await operation(active?.generation)
    } finally {
      try {
        if (registered) await this.deleteRaw(KV.graphDerivedInflight, mutationId)
      } finally {
        liveInflightOperations.delete(operationToken)
      }
    }
  }
}
