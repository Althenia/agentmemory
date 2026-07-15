import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIOAuthProvider } from "../src/providers/openai-oauth.js";
import { OpenAIOAuthStore } from "../src/openai-oauth/store.js";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "agentmemory-oauth-provider-"));
  cleanup.push(dir);
  const store = new OpenAIOAuthStore(join(dir, "oauth.json"));
  await store.save({ accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 60_000, accountId: "acct_123" });
  return store;
}

describe("OpenAI OAuth provider", () => {
  it("sends a Responses request with bearer and account headers", async () => {
    const store = await setup();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ output_text: "done" }), { status: 200 }));
    const provider = new OpenAIOAuthProvider("gpt-5.4-mini", 512, store);

    await expect(provider.summarize("system", "user")).resolves.toBe("done");
    expect(fetch).toHaveBeenCalledWith("https://chatgpt.com/backend-api/codex/responses", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer access", "ChatGPT-Account-ID": "acct_123" }),
      body: expect.stringContaining('"stream":true'),
    }));
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).not.toHaveProperty("max_output_tokens");
  });

  it("assembles streamed output text deltas", async () => {
    const store = await setup();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response([
      "event: response.output_text.delta",
      'data: {"delta":"<type>"}',
      "event: response.output_text.delta",
      'data: {"delta":"decision</type>"}',
      "event: response.completed",
      'data: {}',
      "data: [DONE]",
      "",
    ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const provider = new OpenAIOAuthProvider("gpt-5.4-mini", 512, store);

    await expect(provider.summarize("system", "user")).resolves.toBe("<type>decision</type>");
    expect(fetch).toHaveBeenCalledWith("https://chatgpt.com/backend-api/codex/responses", expect.objectContaining({
      body: expect.stringContaining('"store":false'),
    }));
  });

  it("supports GPT-5.3-Codex-Spark", async () => {
    const store = await setup();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ output_text: "done" }), { status: 200 }));
    const provider = new OpenAIOAuthProvider("gpt-5.3-codex-spark", 512, store);

    await expect(provider.summarize("system", "user")).resolves.toBe("done");
    expect(fetch).toHaveBeenCalledWith("https://chatgpt.com/backend-api/codex/responses", expect.objectContaining({
      body: expect.stringContaining('"model":"gpt-5.3-codex-spark"'),
    }));
  });

  it("refreshes once after a 401 and persists the rotated record", async () => {
    const store = await setup();
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: "retried" }), { status: 200 }));
    const provider = new OpenAIOAuthProvider("gpt-5.4-mini", 512, store);

    await expect(provider.compress("system", "user")).resolves.toBe("retried");
    expect((await store.load())?.accessToken).toBe("rotated-access");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects unsupported models before making a network request", async () => {
    const store = await setup();
    const fetch = vi.spyOn(globalThis, "fetch");
    const provider = new OpenAIOAuthProvider("gpt-4o-mini", 512, store);

    await expect(provider.compress("system", "user")).rejects.toThrow("not supported");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a recoverable login instruction after a second 401", async () => {
    const store = await setup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const provider = new OpenAIOAuthProvider("gpt-5.4-mini", 512, store);

    await expect(provider.compress("system", "user")).rejects.toThrow("agentmemory login openai");
  });
});
