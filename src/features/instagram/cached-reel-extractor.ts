import type { CaptionExtractionResult } from "../places/caption";
import type { ReelExtractionCache } from "../places/extraction-cache";
import { reelExtractionKey } from "./reel-identity";
import type { ReelCaption } from "./reel-identity";

export function createCachedReelExtractor(options: {
  readonly extract: (caption: string) => Promise<CaptionExtractionResult>;
  readonly cache?: ReelExtractionCache;
  readonly version?: string;
  readonly onCacheError?: () => void;
}) {
  const pending = new Map<string, Promise<CaptionExtractionResult>>();
  return async (reel: ReelCaption): Promise<CaptionExtractionResult> => {
    const key = reelExtractionKey(reel, options.version ?? "caption-v1");
    if (!key || !options.cache) return options.extract(reel.title);
    const active = pending.get(key);
    if (active) return active;
    const task = loadOrExtract(key, reel.title);
    pending.set(key, task);
    try { return await task; }
    finally { pending.delete(key); }
  };

  async function loadOrExtract(key: string, caption: string): Promise<CaptionExtractionResult> {
    const cache = options.cache;
    if (!cache) return options.extract(caption);
    try {
      const cached = await cache.get(key);
      if (cached) return cached;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      options.onCacheError?.();
    }
    const result = await options.extract(caption);
    switch (result.kind) {
      case "extracted":
      case "no-place":
        try { await cache.put(key, result); }
        catch (error) { if (!(error instanceof Error)) throw error; options.onCacheError?.(); }
        return result;
      case "invalid-output": return result;
      default: { const exhaustive: never = result; return exhaustive; }
    }
  }
}
