import { createDiagnosticLogger } from "../observability/diagnostics";
import type { DiagnosticLogger } from "../observability/diagnostics";
import type { CaptionExtractionResult } from "../places/caption";
import type { ReelExtractionCache } from "../places/extraction-cache";
import { reelExtractionKey } from "./reel-identity";
import type { ReelCaption } from "./reel-identity";

export function createCachedReelExtractor(options: {
  readonly extract: (caption: string) => Promise<CaptionExtractionResult>;
  readonly cache?: ReelExtractionCache;
  readonly version?: string;
  readonly onCacheError?: () => void;
  readonly log?: DiagnosticLogger;
}) {
  const log = createDiagnosticLogger(options.log);
  const pending = new Map<string, Promise<CaptionExtractionResult>>();
  return async (reel: ReelCaption): Promise<CaptionExtractionResult> => {
    const key = reelExtractionKey(reel, options.version ?? "caption-v1");
    if (!key || !options.cache) {
      log({
        event: "instagram.caption_cache",
        outcome: "bypass",
        reason: !key ? "no_stable_identity" : "cache_disabled",
      });
      return options.extract(reel.title);
    }
    const active = pending.get(key);
    if (active) {
      log({ event: "instagram.caption_cache", outcome: "coalesced" });
      return active;
    }
    const task = loadOrExtract(key, reel.title);
    pending.set(key, task);
    try {
      return await task;
    } finally {
      pending.delete(key);
    }
  };

  async function loadOrExtract(
    key: string,
    caption: string,
  ): Promise<CaptionExtractionResult> {
    const cache = options.cache;
    if (!cache) return options.extract(caption);
    try {
      const cached = await cache.get(key);
      if (cached) {
        log({
          event: "instagram.caption_cache",
          outcome: "hit",
          result: cached.kind,
        });
        return cached;
      }
      log({ event: "instagram.caption_cache", outcome: "miss" });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      log({ event: "instagram.caption_cache", outcome: "read_failed" });
      options.onCacheError?.();
    }
    const result = await options.extract(caption);
    switch (result.kind) {
      case "extracted":
      case "no-place":
        try {
          await cache.put(key, result);
          log({
            event: "instagram.caption_cache",
            outcome: "stored",
            result: result.kind,
          });
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          log({ event: "instagram.caption_cache", outcome: "write_failed" });
          options.onCacheError?.();
        }
        return result;
      case "invalid-output":
        return result;
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  }
}
