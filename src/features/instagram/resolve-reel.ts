import type { CaptionExtractionResult, PlaceMention } from "../places/caption";
import type { MatchPlace, PlaceMatchResult } from "../places/google";
import type { ExtractVideo } from "../places/video";
import type { ReelCaption } from "./reel-identity";

// Match results live only for this request. Photo URLs must not be persisted.
export async function resolveReel(
  reel: ReelCaption,
  caption: CaptionExtractionResult,
  match?: MatchPlace,
  video?: ExtractVideo,
): Promise<{
  readonly result: CaptionExtractionResult;
  readonly match?: MatchPlace;
}> {
  if (
    !match ||
    !video ||
    (caption.kind === "invalid-output" && caption.reason !== "ungrounded")
  )
    return { result: caption, match };
  const results = new Map<string, PlaceMatchResult>();
  const key = (mention: PlaceMention) => JSON.stringify(mention);
  const memoized: MatchPlace = async (mention) => {
    const cached = results.get(key(mention));
    if (cached) return cached;
    const result = await match(mention);
    results.set(key(mention), result);
    return result;
  };
  const original = caption.kind === "extracted" ? caption.value.mentions : [];
  const unresolved: PlaceMention[] = [];
  for (const mention of original) {
    const result = await memoized(mention);
    if (
      result.kind === "ambiguous" ||
      result.kind === "not-found" ||
      ((result.kind === "matched" || result.kind === "no-photo") &&
        result.place.confidence === "possible")
    )
      unresolved.push(mention);
  }
  if (original.length && !unresolved.length)
    return { result: caption, match: memoized };
  let fallback;
  try {
    fallback = await video({ url: reel.url, caption: reel.title, unresolved });
  } catch {
    return { result: caption, match: memoized };
  }
  if (fallback.kind !== "extracted")
    return { result: caption, match: memoized };
  const merged = [...original];
  const identity = (mention: PlaceMention) =>
    mention.name
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  const resolvedIds = new Set<string>();
  for (const result of results.values())
    if (
      (result.kind === "matched" || result.kind === "no-photo") &&
      result.place.confidence !== "possible"
    )
      resolvedIds.add(result.place.id);
  for (const mention of fallback.value.mentions) {
    const result = await memoized(mention);
    if (result.kind !== "matched" && result.kind !== "no-photo") continue;
    if (resolvedIds.has(result.place.id)) continue;
    const index = merged.findIndex(
      (existing) => identity(existing) === identity(mention),
    );
    // A successful caption match always wins over video output.
    if (index >= 0 && !unresolved.includes(merged[index])) continue;
    if (index >= 0) merged[index] = mention;
    else merged.push(mention);
    resolvedIds.add(result.place.id);
  }
  return {
    result: merged.length
      ? { kind: "extracted", value: { mentions: merged } }
      : caption,
    match: memoized,
  };
}
