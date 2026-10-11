import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function saveReelCapture(
  record: Readonly<Record<string, unknown>>,
) {
  const directory = join(process.cwd(), ".local", "instagram-reels");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).length >= 200) {
    throw new RangeError("Reel capture capacity reached");
  }
  await writeFile(
    join(directory, `${randomUUID()}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    {
      mode: 0o600,
      flag: "wx",
    },
  );
}
