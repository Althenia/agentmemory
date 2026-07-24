import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimePolicy } from "../src/config.js";

const INCOMPATIBLE_FLAGS = [
  "GRAPH_EXTRACTION_ENABLED",
  "AUTO_FORGET_ENABLED",
  "LESSON_DECAY_ENABLED",
  "INSIGHT_DECAY_ENABLED",
  "CONSOLIDATION_ENABLED",
] as const;

describe("loadRuntimePolicy", () => {
  beforeEach(() => {
    vi.stubEnv("AGENTMEMORY_OFFLINE_MAINTENANCE", "true");
    vi.stubEnv("AGENTMEMORY_SECRET", "test-secret");
    for (const flag of INCOMPATIBLE_FLAGS) vi.stubEnv(flag, "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves normal runtime behavior by default", () => {
    vi.stubEnv("AGENTMEMORY_OFFLINE_MAINTENANCE", "false");

    expect(loadRuntimePolicy()).toEqual({
      offlineMaintenance: false,
      registerEventTriggers: true,
      healthMonitorEnabled: true,
      backgroundMutationTimersEnabled: true,
      indexPersistenceWritesEnabled: true,
    });
  });

  it("disables automatic writers in offline maintenance mode", () => {
    expect(loadRuntimePolicy()).toEqual({
      offlineMaintenance: true,
      registerEventTriggers: false,
      healthMonitorEnabled: false,
      backgroundMutationTimersEnabled: false,
      indexPersistenceWritesEnabled: false,
    });
  });

  it("requires a configured secret", () => {
    vi.stubEnv("AGENTMEMORY_SECRET", "");

    expect(() => loadRuntimePolicy()).toThrow(
      "AGENTMEMORY_SECRET is required when AGENTMEMORY_OFFLINE_MAINTENANCE=true",
    );
  });

  it("rejects invalid offline maintenance boolean values", () => {
    vi.stubEnv("AGENTMEMORY_OFFLINE_MAINTENANCE", "1");

    expect(() => loadRuntimePolicy()).toThrow(
      'AGENTMEMORY_OFFLINE_MAINTENANCE must be "true" or "false"',
    );
  });

  it.each(INCOMPATIBLE_FLAGS)("rejects explicitly enabled %s", (flag) => {
    vi.stubEnv(flag, "true");

    expect(() => loadRuntimePolicy()).toThrow(
      `${flag}=true is incompatible with AGENTMEMORY_OFFLINE_MAINTENANCE=true`,
    );
  });

  it.each(INCOMPATIBLE_FLAGS)("rejects invalid %s boolean values", (flag) => {
    vi.stubEnv(flag, "1");

    expect(() => loadRuntimePolicy()).toThrow(
      `${flag} must be "true" or "false" when AGENTMEMORY_OFFLINE_MAINTENANCE=true`,
    );
  });
});
