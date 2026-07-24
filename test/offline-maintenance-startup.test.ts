import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  policy: {
    offlineMaintenance: false,
    registerEventTriggers: true,
    healthMonitorEnabled: true,
    backgroundMutationTimersEnabled: true,
    indexPersistenceWritesEnabled: true,
  },
  policyError: null as Error | null,
  registerWorker: vi.fn(),
  registerEventTriggers: vi.fn(),
  registerRecentSearchesSweepFunction: vi.fn(),
  registerHealthMonitor: vi.fn(() => ({ stop: vi.fn() })),
  indexPersistenceOptions: [] as Array<{ writesEnabled?: boolean }>,
  indexLoad: vi.fn(async () => ({ bm25: null, vector: null })),
  indexScheduleSave: vi.fn(),
  indexSave: vi.fn(async () => {}),
  indexStop: vi.fn(),
  startViewerServer: vi.fn(() => ({ close: (done: () => void) => done() })),
}));

vi.mock("iii-sdk", () => ({
  registerWorker: runtime.registerWorker,
  TriggerAction: { Void: vi.fn(() => undefined) },
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...actual,
    loadRuntimePolicy: vi.fn(() => {
      if (runtime.policyError) throw runtime.policyError;
      return runtime.policy;
    }),
    loadConfig: vi.fn(() => ({
      engineUrl: "ws://127.0.0.1:49134",
      restPort: 3111,
      streamsPort: 3112,
      provider: { provider: "noop", model: "noop", maxTokens: 4096 },
      tokenBudget: 2000,
      maxObservationsPerSession: 500,
      compressionModel: "noop",
      dataDir: "/tmp/agentmemory-test",
    })),
    loadEmbeddingConfig: vi.fn(() => ({ bm25Weight: 0.4, vectorWeight: 0.6 })),
    loadFallbackConfig: vi.fn(() => ({ providers: [] })),
    loadClaudeBridgeConfig: vi.fn(() => ({
      enabled: false,
      projectPath: "",
      memoryFilePath: "",
      lineBudget: 200,
    })),
    loadTeamConfig: vi.fn(() => null),
    loadSnapshotConfig: vi.fn(() => ({ enabled: false, interval: 3600, dir: "" })),
    isGraphExtractionEnabled: vi.fn(() => false),
    isAutoCompressEnabled: vi.fn(() => false),
    isConsolidationEnabled: vi.fn(() => true),
    isContextInjectionEnabled: vi.fn(() => false),
    isDropStaleIndexEnabled: vi.fn(() => false),
    getEnvVar: vi.fn((key: string) => key === "AGENTMEMORY_SECRET" ? "test-secret" : undefined),
  };
});

vi.mock("../src/providers/index.js", () => ({
  createProvider: vi.fn(() => ({ name: "noop" })),
  createFallbackProvider: vi.fn(() => ({ name: "noop" })),
  createEmbeddingProvider: vi.fn(() => null),
  createImageEmbeddingProvider: vi.fn(() => null),
}));

vi.mock("../src/triggers/events.js", () => ({
  registerEventTriggers: runtime.registerEventTriggers,
}));

vi.mock("../src/functions/recent-searches-sweep.js", () => ({
  registerRecentSearchesSweepFunction: runtime.registerRecentSearchesSweepFunction,
}));

vi.mock("../src/health/monitor.js", () => ({
  registerHealthMonitor: runtime.registerHealthMonitor,
}));

vi.mock("../src/state/index-persistence.js", () => ({
  IndexPersistence: class {
    constructor(
      _kv: unknown,
      _bm25: unknown,
      _vector: unknown,
      options: { writesEnabled?: boolean },
    ) {
      runtime.indexPersistenceOptions.push(options);
    }

    load = runtime.indexLoad;
    scheduleSave = runtime.indexScheduleSave;
    save = runtime.indexSave;
    stop = runtime.indexStop;
  },
}));

vi.mock("../src/functions/search.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/search.js")>();
  return {
    ...actual,
    rebuildIndex: vi.fn(async () => 0),
    setIndexPersistence: vi.fn(),
  };
});

vi.mock("../src/functions/dedup.js", () => ({
  DedupMap: class {
    stop = vi.fn();
  },
}));

vi.mock("../src/viewer/server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/viewer/server.js")>();
  return { ...actual, startViewerServer: runtime.startViewerServer };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

function fakeSdk() {
  return {
    registerFunction: vi.fn(),
    registerTrigger: vi.fn(),
    trigger: vi.fn(async () => null),
    getMeter: vi.fn(),
    shutdown: vi.fn(async () => {}),
    on: vi.fn(),
  };
}

async function startWithPolicy(policy: typeof runtime.policy) {
  runtime.policy = policy;
  runtime.registerWorker.mockReturnValue(fakeSdk());
  await import("../src/index.js");
  await vi.waitFor(() => expect(runtime.startViewerServer).toHaveBeenCalledOnce());
}

describe("startup runtime policy", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let processOn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    runtime.policyError = null;
    runtime.indexPersistenceOptions.length = 0;
    exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    processOn = vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    exit.mockRestore();
    processOn.mockRestore();
    vi.restoreAllMocks();
  });

  it("fails policy validation before worker, timer, or writer registration", async () => {
    runtime.policyError = new Error("invalid offline maintenance policy");
    runtime.registerWorker.mockReturnValue(fakeSdk());

    await import("../src/index.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(runtime.registerWorker).not.toHaveBeenCalled();
    expect(runtime.registerEventTriggers).not.toHaveBeenCalled();
    expect(runtime.registerRecentSearchesSweepFunction).not.toHaveBeenCalled();
    expect(runtime.registerHealthMonitor).not.toHaveBeenCalled();
    expect(runtime.indexPersistenceOptions).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("registers no automatic writer, event, or sweep hooks offline", async () => {
    await startWithPolicy({
      offlineMaintenance: true,
      registerEventTriggers: false,
      healthMonitorEnabled: false,
      backgroundMutationTimersEnabled: false,
      indexPersistenceWritesEnabled: false,
    });

    expect(runtime.registerEventTriggers).not.toHaveBeenCalled();
    expect(runtime.registerRecentSearchesSweepFunction).not.toHaveBeenCalled();
    expect(runtime.registerHealthMonitor).toHaveBeenCalledOnce();
    expect(runtime.registerHealthMonitor).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { enabled: false },
    );
    expect(runtime.indexPersistenceOptions).toEqual([{ writesEnabled: false }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("registers normal automatic hooks exactly once", async () => {
    await startWithPolicy({
      offlineMaintenance: false,
      registerEventTriggers: true,
      healthMonitorEnabled: true,
      backgroundMutationTimersEnabled: true,
      indexPersistenceWritesEnabled: true,
    });

    expect(runtime.registerEventTriggers).toHaveBeenCalledOnce();
    expect(runtime.registerRecentSearchesSweepFunction).toHaveBeenCalledOnce();
    expect(runtime.registerHealthMonitor).toHaveBeenCalledOnce();
    expect(runtime.indexPersistenceOptions).toEqual([{ writesEnabled: true }]);
    expect(vi.getTimerCount()).toBe(5);
  });
});
