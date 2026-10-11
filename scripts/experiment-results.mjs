import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const evidenceDirectory = join(process.cwd(), ".local", "instagram-reels");

const files = await readdir(evidenceDirectory, { withFileTypes: true }).catch(
  (error) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  },
);

const records = await Promise.all(
  files
    .filter((file) => file.isFile() && file.name.endsWith(".json"))
    .map(async (file) => {
      const path = join(evidenceDirectory, file.name);
      return JSON.parse(await readFile(path, "utf8"));
    }),
);

if (records.length === 0) {
  console.log("No Reel captures yet. Send any Reel to MapThat first.");
} else {
  console.log(JSON.stringify(records, null, 2));
}
