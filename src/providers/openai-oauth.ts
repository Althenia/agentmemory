import type { MemoryProvider } from "../types.js";
import { fetchWithTimeout } from "./_fetch.js";
import { OpenAIOAuthStore, isUsableOpenAIOAuthRecord, type OpenAIOAuthRecord } from "../openai-oauth/store.js";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const SUPPORTED_MODELS = new Set(["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]);
const DEFAULT_TIMEOUT_MS = 60_000;

type ResponsesOutput = {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
};

function responseText(data: ResponsesOutput): string | null {
  if (typeof data.output_text === "string" && data.output_text.length > 0) {
    return data.output_text;
  }
  const text = data.output
    ?.flatMap((item) => item.content ?? [])
    .map((item) => item.text)
    .filter((value): value is string => Boolean(value))
    .join("");
  return text || null;
}

function redactBody(body: string): string {
  return body.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 300);
}

export class OpenAIOAuthProvider implements MemoryProvider {
  name = "openai-oauth";
  private refreshInFlight: Promise<OpenAIOAuthRecord | null> | null = null;

  constructor(
    private readonly model: string,
    _maxTokens: number,
    private readonly store = new OpenAIOAuthStore(),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  private async call(systemPrompt: string, userPrompt: string): Promise<string> {
    if (!SUPPORTED_MODELS.has(this.model)) {
      throw new Error(`OpenAI subscription model is not supported: ${this.model}`);
    }
    const record = await this.store.load();
    if (!isUsableOpenAIOAuthRecord(record)) {
      throw new Error("OpenAI subscription login expired. Run `agentmemory login openai`.");
    }
    const response = await this.request(record, systemPrompt, userPrompt);
    if (response.status !== 401) return this.parseResponse(response);

    const refreshed = await this.refresh(record);
    if (!refreshed) {
      throw new Error("OpenAI subscription login expired. Run `agentmemory login openai`.");
    }
    const retry = await this.request(refreshed, systemPrompt, userPrompt);
    if (retry.status === 401) {
      throw new Error("OpenAI subscription login expired. Run `agentmemory login openai`.");
    }
    return this.parseResponse(retry);
  }

  private async request(
    record: OpenAIOAuthRecord,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<Response> {
    const input = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    return fetchWithTimeout(
      CODEX_RESPONSES_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${record.accessToken}`,
          "content-type": "application/json",
          ...(record.accountId ? { "ChatGPT-Account-ID": record.accountId } : {}),
        },
        body: JSON.stringify({ model: this.model, input, stream: true, store: false }),
      },
      this.timeoutMs,
    );
  }

  private async parseResponse(response: Response): Promise<string> {
    if (!response.ok) {
      throw new Error(`OpenAI subscription request failed (${response.status}): ${redactBody(await response.text())}`);
    }
    const body = await response.text();
    const trimmedBody = body.trimStart();
    const text = trimmedBody.startsWith("data:") || trimmedBody.startsWith("event:")
      ? streamResponseText(body)
      : responseText(JSON.parse(body) as ResponsesOutput);
    if (!text) throw new Error("OpenAI subscription returned no response text");
    return text;
  }

  private async refresh(previous: OpenAIOAuthRecord): Promise<OpenAIOAuthRecord | null> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshToken(previous).finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  private async refreshToken(previous: OpenAIOAuthRecord): Promise<OpenAIOAuthRecord | null> {
    const response = await fetchWithTimeout("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: previous.refreshToken,
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      }).toString(),
    }, this.timeoutMs);
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<{ access_token: string; refresh_token: string; expires_in: number }>;
    if (!data.access_token || !data.refresh_token || !Number.isFinite(data.expires_in)) return null;
    const next: OpenAIOAuthRecord = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + Number(data.expires_in) * 1000,
      accountId: previous.accountId,
    };
    await this.store.save(next);
    return next;
  }
}

function streamResponseText(body: string): string | null {
  let text = "";
  let eventType: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim();
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as {
        type?: string;
        delta?: string;
        response?: ResponsesOutput;
      };
      const type = event.type ?? eventType;
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        text += event.delta;
      } else if (!text && type === "response.completed" && event.response) {
        text += responseText(event.response) ?? "";
      }
      eventType = undefined;
    } catch {
      // Ignore non-JSON SSE frames; the completed response determines validity.
    }
  }
  return text || null;
}

export { CODEX_RESPONSES_URL, SUPPORTED_MODELS };
