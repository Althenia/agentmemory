import { describe, expect, it, vi } from "vitest";
import { registerGraphFunction } from "../src/functions/graph.js";
import { StateKV } from "../src/state/kv.js";
import { registerApiTriggers } from "../src/triggers/api.js";

interface TriggerRequest {
  function_id: string;
  payload: Record<string, unknown>;
}

function integratedLifecycleApi(
  stateHandler: (request: TriggerRequest) => Promise<unknown>,
): Map<string, (input: unknown) => Promise<unknown>> {
  const functions = new Map<string, (input: unknown) => Promise<unknown>>();
  const sdk = {
    registerFunction: vi.fn((id: string, handler: (input: unknown) => Promise<unknown>) => {
      functions.set(id, handler);
    }),
    registerTrigger: vi.fn(),
    trigger: vi.fn(async (request: TriggerRequest) => {
      if (request.function_id.startsWith("state::")) return stateHandler(request);
      const handler = functions.get(request.function_id);
      if (!handler) throw new Error(`Unexpected function: ${request.function_id}`);
      return handler(request.payload);
    }),
  };
  const kv = new StateKV(sdk as never);
  registerApiTriggers(sdk as never, kv, "test-secret");
  return functions;
}

const authorizedRequest = (body: Record<string, unknown>) => ({
  headers: { authorization: ["Bearer", "test-secret"].join(" ") },
  body,
});

describe("graph derived-index backfill API", () => {
  it("returns an empty healthy status when optional state keys are undefined", async () => {
    const functions = integratedLifecycleApi(async (request) => {
      if (request.function_id === "state::get") return undefined;
      if (request.function_id === "state::list-page") return { items: [] };
      throw new Error(`Unexpected function: ${request.function_id}`);
    });

    await expect(
      functions.get("api::graph-derived-index-v2-status")!(authorizedRequest({})),
    ).resolves.toEqual({
      status_code: 200,
      body: {
        success: true,
        active: null,
        maintenance: null,
        generation: null,
        inFlight: false,
        inFlightMutations: [],
        rollbackInvalidated: false,
      },
    });
  });

  it("registers strict authenticated v2 generation lifecycle routes", async () => {
    const functions = new Map<string, (input: unknown) => Promise<unknown>>();
    const triggers: Array<Record<string, unknown>> = [];
    const trigger = vi.fn(async (request: { function_id: string; payload: unknown }) => ({
      success: true,
      operation: request.function_id,
      payload: request.payload,
    }));
    const sdk = {
      registerFunction: vi.fn((id: string, handler: (input: unknown) => Promise<unknown>) => {
        functions.set(id, handler);
      }),
      registerTrigger: vi.fn((registration: Record<string, unknown>) => {
        triggers.push(registration);
      }),
      trigger,
    };
    registerApiTriggers(sdk as never, {} as never, "test-secret");
    const cases = [
      {
        operation: "begin",
        functionId: "mem::derived-index-v2-begin",
        body: { generation: "gen-a" },
        payload: { generation: "gen-a" },
      },
      {
        operation: "page",
        functionId: "mem::derived-index-v2-page",
        body: { generation: "gen-a", limit: 10 },
        payload: { generation: "gen-a", limit: 10 },
      },
      {
        operation: "status",
        functionId: "mem::derived-index-v2-status",
        body: { generation: "gen-a" },
        payload: { generation: "gen-a" },
      },
      {
        operation: "activate",
        functionId: "mem::derived-index-v2-activate",
        body: { generation: "gen-a" },
        payload: { generation: "gen-a" },
      },
      {
        operation: "rollback",
        functionId: "mem::derived-index-v2-rollback",
        body: { generation: "gen-a" },
        payload: { generation: "gen-a" },
      },
      {
        operation: "recover",
        functionId: "mem::derived-index-v2-recover",
        body: {
          minimumAgeSeconds: 60,
          expectedOwnerToken: "owner-a",
          expectedOperationToken: "operation-a",
          expectedMarkerToken: "marker-a",
        },
        payload: {
          minimumAgeSeconds: 60,
          expectedOwnerToken: "owner-a",
          expectedOperationToken: "operation-a",
          expectedMarkerToken: "marker-a",
        },
      },
    ];

    for (const testCase of cases) {
      const handler = functions.get(`api::graph-derived-index-v2-${testCase.operation}`);
      expect(handler).toBeDefined();
      expect(functions.get(testCase.functionId)).toBeDefined();
      const response = await handler!({
        headers: { authorization: ["Bearer", "test-secret"].join(" ") },
        body: testCase.body,
      });
      expect(response).toMatchObject({ status_code: 200 });
      expect(trigger).toHaveBeenLastCalledWith({
        function_id: testCase.functionId,
        payload: testCase.payload,
      });
      expect(triggers).toContainEqual({
        type: "http",
        function_id: `api::graph-derived-index-v2-${testCase.operation}`,
        config: {
          api_path: `/agentmemory/graph/derived-index/v2/${testCase.operation}`,
          http_method: "POST",
          middleware_function_ids: ["middleware::api-auth"],
        },
      });
    }
    for (const testCase of cases) {
      expect(
        sdk.registerFunction.mock.calls.filter(([id]) => id === testCase.functionId),
      ).toHaveLength(1);
    }
    expect(functions.has("mem::graph-extract")).toBe(false);
  });

  it("does not duplicate lifecycle functions when graph extraction is registered", () => {
    const registerFunction = vi.fn();
    const sdk = {
      registerFunction,
      registerTrigger: vi.fn(),
      trigger: vi.fn(),
    };

    registerGraphFunction(sdk as never, {} as never, {} as never);
    registerApiTriggers(sdk as never, {} as never, "test-secret");

    for (const operation of [
      "begin",
      "page",
      "status",
      "activate",
      "rollback",
      "recover",
    ]) {
      expect(
        registerFunction.mock.calls.filter(
          ([id]) => id === `mem::derived-index-v2-${operation}`,
        ),
      ).toHaveLength(1);
    }
    expect(
      registerFunction.mock.calls.filter(([id]) => id === "mem::graph-extract"),
    ).toHaveLength(1);
  });

  it("rejects unknown v2 fields and requires configured authentication", async () => {
    const functions = new Map<string, (input: unknown) => Promise<unknown>>();
    const sdk = {
      registerFunction: vi.fn((id: string, handler: (input: unknown) => Promise<unknown>) => {
        functions.set(id, handler);
      }),
      registerTrigger: vi.fn(),
      trigger: vi.fn(),
    };
    registerApiTriggers(sdk as never, {} as never);
    const handler = functions.get("api::graph-derived-index-v2-begin");
    expect(handler).toBeDefined();

    expect(await handler!({ body: { generation: "gen-a" } })).toEqual({
      status_code: 503,
      body: { error: "Derived-index migration requires AGENTMEMORY_SECRET" },
    });

    const securedFunctions = new Map<string, (input: unknown) => Promise<unknown>>();
    const securedTrigger = vi.fn();
    registerApiTriggers({
      registerFunction: vi.fn((id: string, fn: (input: unknown) => Promise<unknown>) => {
        securedFunctions.set(id, fn);
      }),
      registerTrigger: vi.fn(),
      trigger: securedTrigger,
    } as never, {} as never, "test-secret");
    const secured = securedFunctions.get("api::graph-derived-index-v2-begin")!;
    const response = await secured({
      headers: { authorization: ["Bearer", "test-secret"].join(" ") },
      body: { generation: "gen-a", ignored: true },
    });
    expect(response).toMatchObject({ status_code: 400 });
    const page = securedFunctions.get("api::graph-derived-index-v2-page")!;
    expect(await page({
      headers: { authorization: ["Bearer", "test-secret"].join(" ") },
      body: { generation: "gen-a", limit: "10" },
    })).toMatchObject({ status_code: 400 });
    const recover = securedFunctions.get("api::graph-derived-index-v2-recover");
    expect(recover).toBeDefined();
    expect(await recover!({
      headers: { authorization: ["Bearer", "test-secret"].join(" ") },
      body: {
        minimumAgeSeconds: 60,
        expectedOwnerToken: "owner-a",
      },
    })).toMatchObject({ status_code: 400 });
    expect(await recover!({
      headers: { authorization: ["Bearer", "test-secret"].join(" ") },
      body: {
        minimumAgeSeconds: 60,
        expectedMarkerToken: "marker-a",
        ignored: true,
      },
    })).toMatchObject({ status_code: 400 });
    securedTrigger.mockClear();
    const status = securedFunctions.get("api::graph-derived-index-v2-status")!;
    expect(await status({
      headers: { authorization: ["Bearer", "test-secret"].join(" ") },
      body: { generation: 42 },
    })).toMatchObject({ status_code: 400 });
    expect(securedTrigger).not.toHaveBeenCalled();
  });

  it("maps v2 lifecycle failures to their non-2xx operator status", async () => {
    const functions = new Map<string, (input: unknown) => Promise<unknown>>();
    const sdk = {
      registerFunction: vi.fn((id: string, handler: (input: unknown) => Promise<unknown>) => {
        functions.set(id, handler);
      }),
      registerTrigger: vi.fn(),
      trigger: vi.fn().mockResolvedValue({
        success: false,
        statusCode: 409,
        error: "generation incomplete",
      }),
    };
    registerApiTriggers(sdk as never, {} as never, "test-secret");

    const response = await functions.get("api::graph-derived-index-v2-activate")!({
      headers: { authorization: ["Bearer", "test-secret"].join(" ") },
      body: { generation: "gen-a" },
    });

    expect(response).toEqual({
      status_code: 409,
      body: { error: "generation incomplete" },
    });
  });

  it("returns 500 when lifecycle state storage is unavailable", async () => {
    const functions = integratedLifecycleApi(async () => {
      throw new Error("state unavailable");
    });

    const response = await functions.get("api::graph-derived-index-v2-begin")!(
      authorizedRequest({ generation: "gen-a" }),
    );

    expect(response).toEqual({
      status_code: 500,
      body: { error: "state unavailable" },
    });
  });

  it("returns 500 for corrupt lifecycle state responses", async () => {
    const functions = integratedLifecycleApi(async ({ function_id, payload }) => {
      if (
        function_id === "state::get" &&
        payload.scope === "mem:graph:index:v2:metadata" &&
        payload.key === "maintenance"
      ) return { corrupt: true };
      return null;
    });

    const response = await functions.get("api::graph-derived-index-v2-begin")!(
      authorizedRequest({ generation: "gen-a" }),
    );

    expect(response).toEqual({
      status_code: 500,
      body: { error: "invalid derived-index maintenance metadata" },
    });
  });

  it("returns 409 for an explicit lifecycle conflict", async () => {
    const functions = integratedLifecycleApi(async ({ function_id, payload }) => {
      if (
        function_id === "state::get" &&
        payload.scope === "mem:graph:index:v2:metadata" &&
        payload.key === "maintenance"
      ) {
        return {
          version: 2,
          operation: "rollback",
          generation: "gen-other",
          ownerToken: "owner-other",
          startedAt: "2026-01-01T00:00:00.000Z",
        };
      }
      return null;
    });

    const response = await functions.get("api::graph-derived-index-v2-begin")!(
      authorizedRequest({ generation: "gen-a" }),
    );

    expect(response).toEqual({
      status_code: 409,
      body: { error: "derived-index maintenance is already active for gen-other" },
    });
  });

  it("registers an authenticated route and forwards only validated fields", async () => {
    const functions = new Map<string, (input: unknown) => Promise<unknown>>();
    const triggers: Array<Record<string, unknown>> = [];
    const trigger = vi.fn().mockResolvedValue({
      success: true,
      processed: 10,
      nextCursor: "node-10",
      complete: false,
    });
    const sdk = {
      registerFunction: vi.fn((id: string, handler: (input: unknown) => Promise<unknown>) => {
        functions.set(id, handler);
      }),
      registerTrigger: vi.fn((registration: Record<string, unknown>) => {
        triggers.push(registration);
      }),
      trigger,
    };
    registerApiTriggers(sdk as never, {} as never, "test-secret");

    const handler = functions.get("api::graph-derived-index-backfill");
    expect(handler).toBeDefined();
    const response = await handler!({
      headers: { authorization: "Bearer test-secret" },
      body: {
        kind: "graph-nodes",
        cursor: "node-0",
        limit: 10,
        ignored: "value",
      },
    });

    expect(response).toEqual({
      status_code: 200,
      body: {
        success: true,
        processed: 10,
        nextCursor: "node-10",
        complete: false,
      },
    });
    expect(trigger).toHaveBeenCalledWith({
      function_id: "mem::derived-index-backfill",
      payload: {
        kind: "graph-nodes",
        sessionId: undefined,
        cursor: "node-0",
        limit: 10,
      },
    });
    expect(triggers).toContainEqual({
      type: "http",
      function_id: "api::graph-derived-index-backfill",
      config: {
        api_path: "/agentmemory/graph/derived-index/backfill",
        http_method: "POST",
        middleware_function_ids: ["middleware::api-auth"],
      },
    });
  });

  it("returns a processing error when backfill reports failure", async () => {
    const functions = new Map<string, (input: unknown) => Promise<unknown>>();
    const sdk = {
      registerFunction: vi.fn((id: string, handler: (input: unknown) => Promise<unknown>) => {
        functions.set(id, handler);
      }),
      registerTrigger: vi.fn(),
      trigger: vi.fn().mockResolvedValue({ success: false, error: "index write failed" }),
    };
    registerApiTriggers(sdk as never, {} as never, "test-secret");

    const handler = functions.get("api::graph-derived-index-backfill");
    const response = await handler!({
      headers: { authorization: "Bearer test-secret" },
      body: { kind: "graph-nodes" },
    });

    expect(response).toEqual({
      status_code: 500,
      body: { error: "index write failed" },
    });
  });
});
