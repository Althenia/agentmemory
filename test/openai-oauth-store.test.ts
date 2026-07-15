import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenAIOAuthStore,
  type OpenAIOAuthRecord,
} from "../src/openai-oauth/store.js";

const records: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(records.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function makeStore(): Promise<{ path: string; store: OpenAIOAuthStore }> {
  const dir = await mkdtemp(join(tmpdir(), "agentmemory-oauth-"));
  records.push(dir);
  const path = join(dir, "openai-oauth.json");
  return { path, store: new OpenAIOAuthStore(path) };
}

const record: OpenAIOAuthRecord = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.now() + 60_000,
  accountId: "acct_123",
};

describe("OpenAI OAuth store", () => {
  it("saves and loads a complete record with mode 0600", async () => {
    const { path, store } = await makeStore();

    await store.save(record);

    expect(await store.load()).toEqual(record);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(record);
  });

  it("rejects malformed and expired records", async () => {
    const { path, store } = await makeStore();
    const { writeFile } = await import("node:fs/promises");

    await writeFile(path, JSON.stringify({ ...record, expiresAt: Date.now() - 1 }));
    expect(await store.load()).toBeNull();

    await writeFile(path, JSON.stringify({ accessToken: "only-one-field" }));
    expect(await store.load()).toBeNull();
  });

  it("replaces the complete record and clears only its own file", async () => {
    const { path, store } = await makeStore();
    const replacement = { ...record, accessToken: "rotated" };

    await store.save(record);
    await store.save(replacement);
    expect(await store.load()).toEqual(replacement);

    await store.clear();
    expect(await store.load()).toBeNull();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns null when the store file does not exist", async () => {
    const { store } = await makeStore();
    expect(await store.load()).toBeNull();
  });
});
