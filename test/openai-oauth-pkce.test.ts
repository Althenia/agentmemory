import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  createOAuthState,
  createPkceChallenge,
  constantTimeEqual,
} from "../src/openai-oauth/pkce.js";

describe("OpenAI OAuth PKCE helpers", () => {
  it("creates a verifier and matching S256 challenge", () => {
    const result = createPkceChallenge();
    const expected = createHash("sha256")
      .update(result.verifier)
      .digest("base64url");

    expect(result.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(result.challenge).toBe(expected);
  });

  it("creates unique URL-safe state values", () => {
    const first = createOAuthState();
    const second = createOAuthState();

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it("compares state values without accepting different lengths", () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "different")).toBe(false);
    expect(constantTimeEqual("same", "same ")).toBe(false);
  });
});
