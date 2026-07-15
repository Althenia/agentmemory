import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuthorizationUrl, exchangeCode, parseAccountId, parseCallbackUrl, waitForCallback } from "../src/cli/openai-auth.js";
import { runOpenAILogin } from "../src/cli/openai-auth.js";
import { OpenAIOAuthStore } from "../src/openai-oauth/store.js";

describe("OpenAI CLI OAuth", () => {
  it("builds a PKCE authorization URL without credentials", () => {
    const url = new URL(buildAuthorizationUrl("state", "challenge"));
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("originator")).toBe("agentmemory");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(url.searchParams.has("refresh_token")).toBe(false);
  });

  it("derives the ChatGPT account id from the id token", () => {
    const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: "acct_123" })).toString("base64url");
    expect(parseAccountId(`header.${payload}.signature`)).toBe("acct_123");
    expect(parseAccountId("not-a-jwt")).toBeUndefined();
  });

  it("exchanges an authorization code and returns only the persisted credential shape", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      id_token: `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: "acct_123" })).toString("base64url")}.signature`,
    }), { status: 200 }));

    const result = await exchangeCode("code", "verifier", fetch);

    expect(result.accessToken).toBe("access");
    expect(result.refreshToken).toBe("refresh");
    expect(result.accountId).toBe("acct_123");
    expect(fetch).toHaveBeenCalledWith("https://auth.openai.com/oauth/token", expect.objectContaining({ method: "POST" }));
  });

  it("does not leave a callback timeout running after the exchange completes", async () => {
    const started = Date.now();

    await expect(waitForCallback(Promise.resolve("code"))).resolves.toBe("code");

    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("parses a pasted headless callback URL and preserves the authorization code", () => {
    expect(parseCallbackUrl("http://localhost:1455/auth/callback?code=abc123&state=state")).toEqual({
      code: "abc123",
      state: "state",
    });
  });

  it("rejects a pasted callback that is not the OAuth callback path", () => {
    expect(() => parseCallbackUrl("https://example.com/?code=abc123&state=state")).toThrow(/callback URL/i);
  });

  it("runs headless login without opening a browser", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentmemory-headless-"));
    const output: string[] = [];
    const store = new OpenAIOAuthStore(join(home, "openai-oauth.json"));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_auth_id: "device-id",
        user_code: "USER-CODE",
        interval: 0,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_code: "authorization-code",
        code_verifier: "device-verifier",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
      }), { status: 200 }));

    try {
      await runOpenAILogin(["openai", "--headless"], {
        store,
        fetch,
        sleep: async () => undefined,
        write: (message) => output.push(message),
      });
      expect(output.join(" ")).toContain("https://auth.openai.com/codex/device");
      expect(fetch).toHaveBeenNthCalledWith(1, "https://auth.openai.com/api/accounts/deviceauth/usercode", expect.objectContaining({ method: "POST" }));
      expect(fetch).toHaveBeenNthCalledWith(2, "https://auth.openai.com/api/accounts/deviceauth/token", expect.objectContaining({ method: "POST" }));
      expect(output.join(" ")).toContain("OpenAI login complete");
      expect(await store.load()).toMatchObject({ accessToken: "access" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
