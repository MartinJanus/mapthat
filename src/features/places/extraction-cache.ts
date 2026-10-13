import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { captionExtractionSchema } from "./caption";

const cachedExtractionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("extracted"), value: captionExtractionSchema }),
  z.object({ kind: z.literal("no-place") }),
]);
export type CachedExtraction = z.infer<typeof cachedExtractionSchema>;
export type ReelExtractionCache = {
  readonly get: (key: string) => Promise<CachedExtraction | undefined>;
  readonly put: (key: string, result: CachedExtraction) => Promise<void>;
};
const recordSchema = z.object({ schemaVersion: z.literal(1), expiresAt: z.number().int().nonnegative(), result: cachedExtractionSchema });
const keySchema = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_RECORD_BYTES = 256 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export function createFileExtractionCache(options: {
  readonly directory?: string;
  readonly now?: () => number;
  readonly retentionMs?: number;
  readonly capacity?: number;
} = {}): ReelExtractionCache {
  const directory = options.directory ?? join(process.cwd(), ".local", "reel-extractions");
  const now = options.now ?? Date.now;
  const retention = z.number().int().positive().parse(options.retentionMs ?? RETENTION_MS);
  const capacity = z.number().int().positive().parse(options.capacity ?? 1000);
  let writes = Promise.resolve();

  async function read(path: string) {
    let handle;
    try {
      handle = await open(path, "r");
      if ((await handle.stat()).size > MAX_RECORD_BYTES) return undefined;
      const input: unknown = JSON.parse(await handle.readFile("utf8"));
      const parsed = recordSchema.safeParse(input);
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return undefined;
      throw error;
    } finally { await handle?.close(); }
  }

  return {
    async get(key) {
      const record = await read(join(directory, `${keySchema.parse(key)}.json`));
      return record && record.expiresAt > now() ? record.result : undefined;
    },
    put(key, result) {
      const filename = `${keySchema.parse(key)}.json`;
      const task = writes.then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const files = (await readdir(directory)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file));
        let count = 0;
        for (const file of files) {
          const record = await read(join(directory, file));
          if (!record || record.expiresAt <= now()) await unlink(join(directory, file));
          else if (file !== filename) count++;
        }
        if (count >= capacity) return;
        const temporary = join(directory, `${filename}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify({ schemaVersion: 1, expiresAt: now() + retention, result }), { flag: "wx", mode: 0o600 });
          await rename(temporary, join(directory, filename));
        } finally {
          try { await unlink(temporary); }
          catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
        }
      });
      writes = task.catch((error: unknown) => { if (!(error instanceof Error)) throw error; });
      return task;
    },
  };
}
