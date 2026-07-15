# OpenAI Subscription OAuth Design

## Goal

Enable AgentMemory's LLM features to use a ChatGPT Plus or Pro subscription through an AgentMemory-managed OAuth login. The integration is limited to compression, summaries, and consolidation. Embeddings retain their existing configuration.

## Scope

- Add `agentmemory login openai` and `agentmemory logout openai`.
- Authenticate with OpenAI through a PKCE browser flow and loopback callback.
- Store OAuth credentials outside `.env` in `~/.agentmemory/openai-oauth.json` with mode `0600`.
- Add an OAuth-backed OpenAI LLM provider that uses the Codex Responses endpoint.
- Preserve existing API-key behavior, configuration, fallback, embeddings, and agent integrations.
- Document the OAuth flow, precedence, and its experimental compatibility status.

## Non-goals

- No generic OAuth framework or support for other providers.
- No OpenAI embedding access through subscription credentials.
- No reuse of Codex CLI credential files.
- No live subscription test fixtures, telemetry, or token export.

## Credential Precedence

1. A real `OPENAI_API_KEY` remains the selected OpenAI LLM credential unless `OPENAI_API_KEY_FOR_LLM=false`.
2. With no selected OpenAI API key, a valid local OAuth record selects the OAuth provider.
3. With neither credential, current provider discovery continues unchanged.
4. OAuth credentials never enter `~/.agentmemory/.env`, environment variables, logs, REST responses, or MCP output.

`OPENAI_MODEL` remains the model override for both OpenAI modes. OAuth defaults to `gpt-5.4-mini` and rejects models that are not supported by the subscription transport.

## Transport Contract Baseline

The implementation follows the current OpenAI Codex CLI contract:

- Authorization endpoint: `https://auth.openai.com/oauth/authorize`.
- Token endpoint: `https://auth.openai.com/oauth/token`.
- Public OAuth client ID: `app_EMoamEEZ73f0CkXaXp7hrann`.
- Scopes: `openid profile email offline_access`.
- Redirect URI: `http://localhost:1455/auth/callback`.
- Subscription Responses endpoint: `https://chatgpt.com/backend-api/codex/responses`.
- Account context: derive `chatgpt_account_id` from the ID token and send it as `ChatGPT-Account-ID` when present.
- Authorization request metadata: `response_type=code`, `code_challenge_method=S256`, `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, and `originator=agentmemory`.
- Token exchange and refresh use `application/x-www-form-urlencoded`; the authorization-code exchange includes `grant_type`, `code`, `redirect_uri`, `client_id`, and `code_verifier`.
- AgentMemory's initial supported model allowlist is `gpt-5.4` and `gpt-5.4-mini`; unsupported values fail before network I/O. This is an AgentMemory compatibility policy, not a guarantee that upstream model availability is permanent.

The endpoint and header values are based on the maintained OpenAI Codex login and Responses implementation. The subscription transport remains experimental and may change upstream.

## Components

### OAuth store

An `OpenAIOAuthStore` owns the OAuth record: access token, refresh token, expiry timestamp, and optional ChatGPT account ID. It reads and writes atomically under `~/.agentmemory/` with mode `0600`. Refresh token rotation replaces the complete record.

### Login command

`agentmemory login openai` starts a loopback server on `127.0.0.1:1455`, generates a PKCE verifier, challenge, and CSRF `state`, then opens the authorization URL. The callback validates `state`, exchanges the code for tokens, derives the account ID, persists the record, and closes the server. The command reports only sanitized success or failure details.

`agentmemory logout openai` removes the OAuth record and leaves API-key configuration untouched.

### OAuth provider

`OpenAIOAuthProvider` implements the existing LLM provider interface. It converts AgentMemory's system and user prompts into Codex Responses requests and extracts response text. It adds the OAuth bearer token and account header, refreshes expired tokens through one shared in-flight operation, and writes the rotated credential record before returning the retried result.

The provider is LLM-only. The existing embedding provider selection remains unchanged.

## Failure Handling

- Reject an invalid OAuth callback state, missing authorization code, cancellation, timeout, token-exchange failure, or callback-port conflict without storing a token.
- On the first 401 response, refresh and retry once. Further authentication failures instruct the user to run `agentmemory login openai`.
- Preserve status information for quota, rate-limit, permission, and model errors while bounding and redacting response bodies.
- Never log authorization URLs with callback parameters, access tokens, refresh tokens, account IDs, or raw provider error bodies.

## Security Constraints

- Use PKCE with SHA-256 and a high-entropy verifier.
- Bind the callback listener to loopback only and enforce a five-minute timeout.
- Validate `state` before exchanging a code.
- Use Node built-ins only; do not add an OAuth dependency.
- Use file mode `0600` and atomic replacement for credential persistence.
- Treat the Codex-compatible subscription endpoint as experimental because it is separate from OpenAI's normal API-key endpoint and may change upstream.

## Verification

- Unit tests for PKCE/state validation, callback exchange, file permissions, token refresh rotation, and redaction.
- Provider tests for API-key precedence, OAuth provider discovery, request conversion, account headers, response extraction, retry-once behavior, and OAuth-only model validation.
- CLI tests for successful login handoff, cancellation, logout, missing credentials, and occupied callback port.
- Documentation checks for `.env` precedence, OAuth's LLM-only scope, login/logout usage, and experimental status.

## Acceptance Criteria

1. A subscriber can run `agentmemory login openai`, complete browser authorization, and use AgentMemory LLM features without `OPENAI_API_KEY`.
2. `OPENAI_API_KEY` retains current precedence and functionality.
3. OAuth does not enable or alter OpenAI embeddings.
4. Tokens are persisted only in the protected OAuth store and never included in diagnostics, errors, or generated config.
5. Expired OAuth sessions refresh automatically once and otherwise yield a recoverable login instruction.
6. `agentmemory logout openai` removes OAuth access without touching `.env` or other providers.
