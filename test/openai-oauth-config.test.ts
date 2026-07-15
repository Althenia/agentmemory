import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenAIOAuthRecord } from "../src/openai-oauth/store.js";
import { detectEmbeddingProvider, detectProvider } from "../src/config.js";

const originalEnv = { ...process.env };
const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  process.env = { ...originalEnv };
  vi.resetModules();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const oauthRecord: OpenAIOAuthRecord = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.now() + 60_000,
};

describe("OpenAI OAuth provider discovery", () => {
  it("selects a valid OAuth record when no API key is available", async () => {
    expect(detectProvider({}, oauthRecord)).toMatchObject({ provider: "openai-oauth", model: "gpt-5.4-mini" });
  });

  it("keeps API-key precedence over OAuth", async () => {
    expect(detectProvider({ OPENAI_API_KEY: "api-key" }, oauthRecord)).toMatchObject({ provider: "openai" });
  });

  it("allows OAuth to replace the LLM key while embeddings keep their API-key path", async () => {
    const env = { OPENAI_API_KEY: "api-key", OPENAI_API_KEY_FOR_LLM: "false" };
    expect(detectProvider(env, oauthRecord).provider).toBe("openai-oauth");
    expect(detectEmbeddingProvider(env)).toBe("openai");
  });
});
