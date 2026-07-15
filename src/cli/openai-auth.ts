import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { platform } from "node:os";
import { spawn } from "node:child_process";
import { OpenAIOAuthStore, type OpenAIOAuthRecord } from "../openai-oauth/store.js";
import { constantTimeEqual, createOAuthState, createPkceChallenge } from "../openai-oauth/pkce.js";
import { fetchWithTimeout } from "../providers/_fetch.js";

export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_DEVICE_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const OPENAI_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const OPENAI_DEVICE_URL = "https://auth.openai.com/codex/device";
export const OPENAI_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

type FetchLike = typeof fetch;

export interface OpenAIAuthDependencies {
  store?: OpenAIOAuthStore;
  fetch?: FetchLike;
  openBrowser?: (url: string) => void;
  write?: (message: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  headlessTimeoutMs?: number;
  createServer?: typeof createServer;
}

function openBrowser(url: string): void {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  const args = platform() === "win32" ? ["", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

export function buildAuthorizationUrl(state: string, challenge: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "agentmemory",
    state,
  });
  return `${OPENAI_OAUTH_AUTHORIZE_URL}?${params}`;
}

function sendCallbackResponse(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function callbackResult(req: IncomingMessage): { code?: string; state?: string; error?: string } | null {
  try {
    return parseCallbackUrl(new URL(req.url ?? "/", "http://127.0.0.1:1455").toString());
  } catch {
    return null;
  }
}

export function parseCallbackUrl(value: string): { code?: string; state?: string; error?: string } {
  const requestUrl = new URL(value);
  if (
    !["localhost", "127.0.0.1"].includes(requestUrl.hostname) ||
    requestUrl.port !== "1455" ||
    requestUrl.pathname !== "/auth/callback"
  ) {
    throw new Error("Invalid OAuth callback URL; expected localhost:1455/auth/callback");
  }
  return {
    code: requestUrl.searchParams.get("code") ?? undefined,
    state: requestUrl.searchParams.get("state") ?? undefined,
    error: requestUrl.searchParams.get("error") ?? undefined,
  };
}

export function parseAccountId(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { chatgpt_account_id?: unknown };
    return typeof claims.chatgpt_account_id === "string" ? claims.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

export async function exchangeCode(
  code: string,
  verifier: string,
  fetchImpl: FetchLike = fetch,
  redirectUri = OPENAI_OAUTH_REDIRECT_URI,
): Promise<OpenAIOAuthRecord> {
  let response: Response;
  try {
    response = await fetchWithTimeout(OPENAI_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: OPENAI_OAUTH_CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
    }, undefined, fetchImpl);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("OpenAI login token exchange timed out; check network access and try again");
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`OpenAI login failed (${response.status})`);
  }
  const data = (await response.json()) as Partial<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    id_token: string;
  }>;
  if (!data.access_token || !data.refresh_token || !Number.isFinite(data.expires_in)) {
    throw new Error("OpenAI login returned an incomplete token response");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
    accountId: parseAccountId(data.id_token),
  };
}

export async function runOpenAILogin(
  args: string[],
  dependencies: OpenAIAuthDependencies = {},
): Promise<void> {
  if (args[0] !== "openai") throw new Error("Usage: agentmemory login openai");
  const state = createOAuthState();
  const pkce = createPkceChallenge();
  const store = dependencies.store ?? new OpenAIOAuthStore();
  const fetchImpl = dependencies.fetch ?? fetch;
  const create = dependencies.createServer ?? createServer;
  const browser = dependencies.openBrowser ?? openBrowser;
  const write = dependencies.write ?? ((message: string) => process.stdout.write(message));
  const authUrl = buildAuthorizationUrl(state, pkce.challenge);

  if (args.includes("--headless")) {
    await runHeadlessLogin(store, fetchImpl, write, dependencies.sleep, dependencies.headlessTimeoutMs);
    write("[agentmemory] OpenAI login complete.\n");
    return;
  }

  const server = create((request, response) => {
    const result = callbackResult(request);
    if (!result) {
      sendCallbackResponse(response, 404, "Not found");
      return;
    }
    if (result.error) {
      sendCallbackResponse(response, 400, "OpenAI login was cancelled. Return to your terminal.");
      server.close();
      callback.reject(new Error(`OpenAI login cancelled: ${result.error}`));
      return;
    }
    if (!result.code || !result.state || !constantTimeEqual(result.state, state)) {
      sendCallbackResponse(response, 400, "Invalid OpenAI login callback.");
      server.close();
      callback.reject(new Error("Invalid OpenAI login callback state"));
      return;
    }
    sendCallbackResponse(response, 200, "Authentication successful. Return to your terminal.");
    server.close();
    callback.resolve(result.code);
  });
  const callback = deferred<string>();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(1455, "127.0.0.1", () => resolve());
    });
    browser(authUrl);
    const code = await waitForCallback(callback.promise);
    write("[agentmemory] Callback received; exchanging authorization code…\n");
    await store.save(await exchangeCode(code, pkce.verifier, fetchImpl));
    write("[agentmemory] OpenAI login complete.\n");
  } finally {
    server.close();
  }
}

async function runHeadlessLogin(
  store: OpenAIOAuthStore,
  fetchImpl: FetchLike,
  write: (message: string) => void,
  sleep: (milliseconds: number) => Promise<void> = delay,
  timeoutMs = LOGIN_TIMEOUT_MS,
): Promise<void> {
  const deviceResponse = await fetchImpl(OPENAI_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "agentmemory" },
    body: JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID }),
  });
  if (!deviceResponse.ok) throw new Error(`OpenAI device authorization failed (${deviceResponse.status})`);
  const device = (await deviceResponse.json()) as Partial<{
    device_auth_id: string;
    user_code: string;
    interval: number;
  }>;
  if (!device.device_auth_id || !device.user_code) {
    throw new Error("OpenAI device authorization returned an incomplete response");
  }
  const intervalMs = Math.max(Number(device.interval ?? 5) * 1000, 1);
  write(`Open ${OPENAI_DEVICE_URL} and enter code: ${device.user_code}\n`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tokenResponse = await fetchImpl(OPENAI_DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "agentmemory" },
      body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
    });
    if (tokenResponse.status === 200) {
      const token = (await tokenResponse.json()) as Partial<{ authorization_code: string; code_verifier: string }>;
      if (!token.authorization_code || !token.code_verifier) {
        throw new Error("OpenAI device authorization returned an incomplete token response");
      }
      write("[agentmemory] Device authorization complete; exchanging authorization code…\n");
      await store.save(await exchangeCode(token.authorization_code, token.code_verifier, fetchImpl, "https://auth.openai.com/deviceauth/callback"));
      return;
    }
    if (tokenResponse.status !== 403 && tokenResponse.status !== 404) {
      throw new Error(`OpenAI device authorization failed (${tokenResponse.status})`);
    }
    await sleep(intervalMs);
  }
  throw new Error("OpenAI device authorization timed out after five minutes");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function waitForCallback(callback: Promise<string>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((_, reject) => {
    timer = setTimeout(() => reject(new Error("OpenAI login timed out after five minutes")), LOGIN_TIMEOUT_MS);
  });
  return Promise.race([callback, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function runOpenAILogout(args: string[], store = new OpenAIOAuthStore()): Promise<void> {
  if (args[0] !== "openai") throw new Error("Usage: agentmemory logout openai");
  await store.clear();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
