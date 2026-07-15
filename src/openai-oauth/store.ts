import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface OpenAIOAuthRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
}

function defaultPath(): string {
  return join(homedir(), ".agentmemory", "openai-oauth.json");
}

function isRecord(value: unknown): value is OpenAIOAuthRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OpenAIOAuthRecord>;
  return (
    typeof candidate.accessToken === "string" &&
    candidate.accessToken.length > 0 &&
    typeof candidate.refreshToken === "string" &&
    candidate.refreshToken.length > 0 &&
    typeof candidate.expiresAt === "number" &&
    Number.isFinite(candidate.expiresAt) &&
    candidate.expiresAt > Date.now() &&
    (candidate.accountId === undefined || typeof candidate.accountId === "string")
  );
}

export class OpenAIOAuthStore {
  constructor(private readonly path = defaultPath()) {}

  async load(): Promise<OpenAIOAuthRecord | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return isRecord(parsed) ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  loadSync(): OpenAIOAuthRecord | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async save(record: OpenAIOAuthRecord): Promise<void> {
    if (!isRecord(record)) throw new Error("Invalid OpenAI OAuth record");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<void> {
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function isUsableOpenAIOAuthRecord(
  record: OpenAIOAuthRecord | null,
  skewMs = 30_000,
): record is OpenAIOAuthRecord {
  return record !== null && record.expiresAt > Date.now() + skewMs;
}
