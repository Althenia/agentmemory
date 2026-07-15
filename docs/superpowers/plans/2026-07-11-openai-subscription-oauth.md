# OpenAI Subscription OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let AgentMemory use a ChatGPT Plus or Pro subscription for compression, summaries, and consolidation through a protected OAuth flow while preserving API-key behavior and existing embeddings.

**Architecture:** Keep OAuth state in a small Node-built-in module under `src/openai-oauth/`, keep CLI browser/callback orchestration separate from token persistence, and expose OAuth as a distinct `MemoryProvider` implementation. Provider discovery selects API key first, then a valid local OAuth record; embedding discovery remains unchanged.

**Tech Stack:** TypeScript ESM, Node.js built-ins (`crypto`, `fs`, `http`, `net`, `path`, `os`), raw `fetch`, Vitest, existing `@clack/prompts` CLI.

## Global Constraints

- OAuth is limited to compression, summaries, and consolidation; embeddings retain their existing configuration.
- `OPENAI_API_KEY` remains selected unless `OPENAI_API_KEY_FOR_LLM=false`; otherwise a valid local OAuth record is selected before normal provider discovery.
- OAuth credentials are stored only at `~/.agentmemory/openai-oauth.json`, persisted atomically with file mode `0600`.
- OAuth credentials never enter `.env`, environment variables, logs, REST responses, or MCP output.
- The callback binds to `127.0.0.1:1455` and expires after five minutes.
- PKCE uses a high-entropy verifier, SHA-256 challenge, and CSRF `state` validation.
- No OAuth dependency is added; no Codex CLI credential file is reused.
- A 401 refreshes and retries once; a second authentication failure produces a recoverable `agentmemory login openai` instruction.
- The subscription transport is experimental and must be documented as such.

---

## Repository Map and Design Audit

Confirmed live files:

- `src/config.ts` owns environment merging and `detectProvider()`; it currently selects OpenAI API key before other LLM providers.
- `src/types.ts` defines `ProviderConfig`, `ProviderType`, and `MemoryProvider`.
- `src/providers/index.ts` constructs the concrete provider and currently requires `OPENAI_API_KEY` for `openai`.
- `src/providers/openai.ts` is the raw-fetch Chat Completions provider with shared timeout and error conventions.
- `src/providers/_fetch.ts` owns bounded raw-fetch requests.
- `src/cli.ts` owns help text and command dispatch through the `commands` map.
- `test/openai-shared.test.ts`, `test/summarize.test.ts`, `test/cli-*.test.ts`, and `test/env-loader.test.ts` establish the existing unit-test patterns.

Open protocol decisions must be fixed before implementation begins; the design document does not specify them and the plan must not invent them:

1. Authorization URL, token URL, client identifier, scopes, and exact redirect URI.
2. The account identifier derivation and exact header name/value format required by the Codex-compatible Responses transport.
3. The supported OAuth model allowlist and the provider endpoint path/request schema.

These are Task 1 acceptance gates. Until they are confirmed from an approved upstream contract, no network-facing implementation should be started.

## Task 1: Lock the subscription transport contract

**Files:**
- Modify: `docs/superpowers/specs/2026-07-11-openai-subscription-oauth-design.md`
- Test: none; this is a design-contract gate

**Interfaces:**
- Produces: constants and request/response field names consumed by Tasks 2–5.

- [ ] **Step 1: Record the five protocol constants and schemas**

  Add the authorization URL, token URL, client ID, scopes, redirect URI, account header contract, Responses endpoint path, token exchange fields, refresh fields, and supported model list to the design spec.

- [ ] **Step 2: Define the transport acceptance examples**

  Record one sanitized authorization request, one token response shape, one refresh response shape, one Responses request shape, and the expected successful text extraction shape. Do not include live credentials.

- [ ] **Step 3: Gate implementation on contract completeness**

  Confirm the revised spec has no unresolved protocol field. If any field remains unknown, stop before code changes and surface the exact missing decision.

## Task 2: Build the protected OAuth store and protocol helpers

**Files:**
- Create: `src/openai-oauth/store.ts`
- Create: `src/openai-oauth/pkce.ts`
- Create: `test/openai-oauth-store.test.ts`
- Create: `test/openai-oauth-pkce.test.ts`

**Interfaces:**
- Produces `OpenAIOAuthRecord`, `OpenAIOAuthStore.load()`, `OpenAIOAuthStore.save()`, `OpenAIOAuthStore.clear()`, `createPkceChallenge()`, and `createOAuthState()` for later tasks.

- [ ] **Step 1: Write failing tests for record validation and file location**

  Cover missing fields, expired records, malformed timestamps, the default path under `~/.agentmemory/`, and an injected temporary home/path so tests never touch the user’s real home.

- [ ] **Step 2: Write failing tests for permissions and atomic replacement**

  Assert that a saved file has mode `0600`, that parent directories are created safely, that replacement uses a temporary sibling followed by rename, and that a failed write does not delete the previous valid record.

- [ ] **Step 3: Implement the store with complete-record replacement**

  Use `mkdir`, `writeFile`, `chmod`, and `rename` from `node:fs/promises`; serialize only access token, refresh token, expiry timestamp, and optional account ID. `clear()` removes only the OAuth file.

- [ ] **Step 4: Write failing PKCE/state tests**

  Assert verifier entropy/URL-safe encoding, SHA-256 challenge derivation, unique state values, and constant-time state comparison for callback validation.

- [ ] **Step 5: Implement PKCE/state helpers and run focused tests**

  Run:

  ```bash
  npm test -- test/openai-oauth-store.test.ts test/openai-oauth-pkce.test.ts
  ```

  Expected: all focused tests pass.

## Task 3: Add CLI login/logout and loopback callback handling

**Files:**
- Create: `src/cli/openai-auth.ts`
- Modify: `src/cli.ts` (help text, imports, command map)
- Create: `test/cli-openai-auth.test.ts`

**Interfaces:**
- Consumes the Task 2 store/helpers and Task 1 transport constants.
- Produces `runOpenAILogin(args)` and `runOpenAILogout(args)` for `agentmemory login openai` and `agentmemory logout openai`.

- [ ] **Step 1: Write failing CLI tests**

  Cover successful callback exchange, invalid state, missing code, user cancellation, five-minute timeout, occupied port, logout, and sanitized failure output. Mock browser opening, loopback HTTP, token exchange, and the OAuth store.

- [ ] **Step 2: Implement callback lifecycle**

  Bind only to `127.0.0.1:1455`, generate state and PKCE values per login, accept exactly one callback, validate state before token exchange, close the server on every exit path, and bound the wait to five minutes.

- [ ] **Step 3: Implement sanitized token exchange and persistence**

  Use the approved Task 1 URLs and fields, reject non-success responses without persisting tokens, derive the approved account ID, and save the complete rotated record through `OpenAIOAuthStore`.

- [ ] **Step 4: Wire CLI dispatch and help**

  Add `login` and `logout` handlers that require the `openai` subcommand, keep existing commands unchanged, and document experimental status plus the LLM-only scope in `src/cli.ts` help.

- [ ] **Step 5: Run focused CLI tests**

  ```bash
  npm test -- test/cli-openai-auth.test.ts
  ```

  Expected: all login/logout branches pass without opening a real browser or network socket outside the test harness.

## Task 4: Add OAuth provider discovery and Responses transport

**Files:**
- Create: `src/providers/openai-oauth.ts`
- Modify: `src/config.ts`
- Modify: `src/types.ts`
- Modify: `src/providers/index.ts`
- Create: `test/openai-oauth-provider.test.ts`
- Modify: `test/env-loader.test.ts`

**Interfaces:**
- Consumes `OpenAIOAuthStore` and Task 1 transport contract.
- Produces an OAuth-backed `MemoryProvider` with `compress()` and `summarize()` plus provider discovery state that distinguishes API-key and OAuth modes.

- [ ] **Step 1: Write failing discovery tests**

  Assert API key precedence, `OPENAI_API_KEY_FOR_LLM=false` allowing OAuth, expired/malformed OAuth records falling through safely, OAuth selection without changing embedding selection, and unchanged no-credential behavior.

- [ ] **Step 2: Extend provider configuration minimally**

  Add the smallest explicit provider representation needed to distinguish API-key OpenAI from OAuth OpenAI; do not make OAuth an embedding provider and do not change `detectEmbeddingProvider()`.

- [ ] **Step 3: Write failing request/response tests**

  Assert system/user prompt conversion to the approved Responses request, bearer authentication, account header, model validation, response text extraction, bounded/redacted error bodies, and preservation of quota/rate-limit/permission/model status information.

- [ ] **Step 4: Implement the OAuth provider**

  Reuse `fetchWithTimeout`, send the approved Responses payload, reject unsupported models before network I/O, and expose only sanitized errors. Keep API-key `OpenAIProvider` behavior intact.

- [ ] **Step 5: Implement one shared refresh-and-retry operation**

  On the first 401, coalesce concurrent refreshes, replace the full stored record, and retry once. On any subsequent authentication failure, throw an error containing only the command `agentmemory login openai`.

- [ ] **Step 6: Run provider and configuration tests**

  ```bash
  npm test -- test/openai-oauth-provider.test.ts test/env-loader.test.ts test/openai-shared.test.ts
  ```

  Expected: OAuth and existing OpenAI/shared transport tests pass together.

## Task 5: Integrate documentation and operational safety

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `CHANGELOG.md`
- Create or modify: `test/documentation.test.ts` only if existing documentation checks require executable assertions

**Interfaces:**
- Consumes the final CLI/provider behavior from Tasks 3–4.
- Produces user-facing setup, precedence, logout, recovery, and experimental-status documentation.

- [ ] **Step 1: Document login/logout and credential precedence**

  Show `agentmemory login openai`, `agentmemory logout openai`, API-key precedence, `OPENAI_API_KEY_FOR_LLM=false`, the LLM-only scope, protected storage location, and the fact that embeddings are unaffected.

- [ ] **Step 2: Document failure recovery and experimental status**

  Explain callback cancellation/port conflict, expired-session recovery, one-time refresh behavior, and the experimental Codex-compatible transport without promising subscription API stability.

- [ ] **Step 3: Update configuration examples without adding credentials**

  Add commented options and warnings only; never add a token, account identifier, or live authorization URL with callback parameters.

## Task 6: Verify the complete feature and hand off for implementation

**Files:**
- No product-file changes; verification only

- [ ] **Step 1: Run the focused OAuth suite**

  ```bash
  npm test -- test/openai-oauth-store.test.ts test/openai-oauth-pkce.test.ts test/cli-openai-auth.test.ts test/openai-oauth-provider.test.ts
  ```

- [ ] **Step 2: Run the full unit suite and build**

  ```bash
  npm test
  npm run build
  ```

  Expected: both commands exit successfully; no test uses real credentials, browser state, or external subscription access.

- [ ] **Step 3: Inspect the final diff for secret leakage**

  ```bash
  git diff --check
  rg -n "access[_ -]?token|refresh[_ -]?token|OPENAI_API_KEY=|account[_ -]?id" src test docs README.md .env.example
  ```

  Expected: only names, redaction tests, and documentation references appear; no credential values or private tokens are present.

- [ ] **Step 4: Execute only after the plan is approved**

  Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`, with a review checkpoint after each task and no implementation before Task 1’s protocol gate is satisfied.

## Self-Review

- Spec coverage: credential precedence and embedding isolation are covered by Task 4; protected storage and redaction by Task 2/3/5; login/logout and callback failure paths by Task 3; refresh/retry and status handling by Task 4; documentation and experimental status by Task 5; end-to-end validation by Task 6.
- Known gap: the design spec must add the exact upstream protocol values listed in Task 1 before any implementation can safely begin.
- Placeholder scan: no incomplete placeholder or unspecified implementation step is used; the unresolved protocol values are explicitly identified as a prerequisite gate.
- Type consistency: `OpenAIOAuthRecord` and `OpenAIOAuthStore` are introduced in Task 2 and consumed by Tasks 3–4; the provider remains compatible with the existing `MemoryProvider` interface.
