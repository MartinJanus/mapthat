import { describe, expect, it, vi } from "vitest";
import { resolveReel } from "../../src/features/instagram/resolve-reel";
import { selectPlaceMatch } from "../../src/features/places/google";
import type { MatchPlace } from "../../src/features/places/google";
import { place, mention } from "../places/google-fixtures";
import { placeSchema } from "../../src/features/places/google-model";

const reel = {
  title: "Cafe Test in Berlin",
  url: "https://video.cdninstagram.com/reel.mp4",
};
const extracted = {
  kind: "extracted" as const,
  value: { mentions: [mention] },
};
const matched = selectPlaceMatch(mention, [placeSchema.parse(place())]);

describe("caption-first resolution", () => {
  it("skips video when all caption places already match, reusing results for cards", async () => {
    const match = vi.fn<MatchPlace>().mockResolvedValue(matched);
    const video = vi.fn();
    const resolved = await resolveReel(reel, extracted, match, video);
    expect(resolved.result).toEqual(extracted);
    await resolved.match?.(mention);
    expect(match).toHaveBeenCalledOnce();
    expect(video).not.toHaveBeenCalled();
  });
  it("skips video when Places is unavailable or caption extraction failed", async () => {
    const video = vi.fn();
    await resolveReel(
      reel,
      extracted,
      async () => ({ kind: "unavailable" }),
      video,
    );
    await resolveReel(
      reel,
      { kind: "invalid-output", reason: "provider" },
      async () => matched,
      video,
    );
    expect(video).not.toHaveBeenCalled();
  });
  it("uses video for a captionless Reel and verifies the result with Places", async () => {
    const video = vi.fn().mockResolvedValue(extracted);
    const resolved = await resolveReel(
      { ...reel, title: "" },
      { kind: "no-place" },
      async () => matched,
      video,
    );
    expect(resolved.result).toEqual(extracted);
    expect(video).toHaveBeenCalledOnce();
  });
  it("retains successful caption matches and resolves missing geography once", async () => {
    const unresolved = {
      ...mention,
      name: "Another Cafe",
      city: null,
      country: null,
    };
    const enriched = { ...unresolved, city: "Berlin", country: "Germany" };
    const otherMatch = selectPlaceMatch(enriched, [
      placeSchema.parse(place("place-2", "Another Cafe")),
    ]);
    const match: MatchPlace = async (candidate) =>
      candidate.name === mention.name
        ? matched
        : candidate.city
          ? otherMatch
          : { kind: "ambiguous" };
    const video = vi.fn().mockResolvedValue({
      kind: "extracted",
      value: { mentions: [enriched] },
    });
    const resolved = await resolveReel(
      reel,
      { kind: "extracted", value: { mentions: [mention, unresolved] } },
      match,
      video,
    );
    expect(resolved.result).toEqual({
      kind: "extracted",
      value: { mentions: [mention, enriched] },
    });
    expect(video).toHaveBeenCalledOnce();
  });
  it("preserves caption results when video fails or yields an unmatchable venue", async () => {
    for (const videoResult of [{ kind: "unavailable" }, extracted]) {
      const resolved = await resolveReel(
        reel,
        extracted,
        async () => ({ kind: "ambiguous" }),
        async () => videoResult as typeof extracted,
      );
      expect(resolved.result).toEqual(extracted);
    }
  });
  it("uses grounded street context to distinguish same-name branches", () => {
    const a = placeSchema.parse({
      ...place("a"),
      formattedAddress: "1 Main Street, Berlin, Germany",
    });
    const b = placeSchema.parse({
      ...place("b"),
      formattedAddress: "2 Other Street, Berlin, Germany",
    });
    expect(selectPlaceMatch(mention, [a, b])).toEqual({ kind: "ambiguous" });
    expect(
      selectPlaceMatch({ ...mention, addressHint: "Main Street" }, [a, b]),
    ).toMatchObject({ kind: "matched", place: { id: "a" } });
    expect(
      selectPlaceMatch(
        { ...mention, city: "Paris", addressHint: "Main Street" },
        [a, b],
      ),
    ).toEqual({ kind: "ambiguous" });
  });
});
