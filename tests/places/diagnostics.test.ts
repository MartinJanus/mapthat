import { describe, expect, it } from "vitest";
import {
  createDiagnosticLogger,
  withDiagnosticContext,
} from "../../src/features/observability/diagnostics";
import type { DiagnosticRecord } from "../../src/features/observability/diagnostics";
import { preparePlaceCards } from "../../src/features/instagram/place-cards";
import { createCachedReelExtractor } from "../../src/features/instagram/cached-reel-extractor";
import { selectPlaceMatch } from "../../src/features/places/google";
import { placeSchema } from "../../src/features/places/google-model";
import { mention, place, withPlaces } from "./google-fixtures";

describe("pipeline diagnostics", () => {
  it("keeps concurrent request/reel contexts isolated across awaits", async () => {
    const records: DiagnosticRecord[] = [];
    const log = createDiagnosticLogger((record) => records.push(record));
    await Promise.all(
      ["one", "two"].map((requestId) =>
        withDiagnosticContext({ requestId }, async () => {
          await Promise.resolve();
          await withDiagnosticContext({ reelId: requestId }, async () => {
            await Promise.resolve();
            log({ event: requestId });
          });
          log({ event: requestId, scope: "request" });
        }),
      ),
    );
    for (const record of records) {
      expect(record.requestId).toBe(record.event);
      if (record.scope) expect(record.reelId).toBeUndefined();
      else expect(record.reelId).toBe(record.requestId);
    }
    log({ event: "outside" });
    expect(records.at(-1)).toEqual({ event: "outside" });
  });

  it("explains a weak name without logging names, captions or provider URLs", async () => {
    const records: DiagnosticRecord[] = [];
    await withPlaces(
      { places: [place("a", "Unrelated Private Venue")] },
      async (match) => {
        await withDiagnosticContext(
          { requestId: "request", reelId: "reel" },
          async () => {
            const result = await match(mention);
            await preparePlaceCards(
              { mentions: [mention] },
              async () => result,
              (record) => records.push(record),
            );
          },
        );
      },
      { log: (record) => records.push(record) },
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "places.match_decision",
        reason: "weak_name",
        topScore: 0,
        candidateCount: 1,
        geographyCount: 1,
        addressCount: 1,
        nameThreshold: 0.8,
        possibleEnabled: 1,
        requestId: "request",
        reelId: "reel",
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "instagram.place_card",
        placeIndex: 1,
        outcome: "search",
        reason: "ambiguous",
        image: 0,
        requestId: "request",
        reelId: "reel",
      }),
    );
    const referenced = records.filter((record) => record.placeRef);
    expect(new Set(referenced.map((record) => record.placeRef)).size).toBe(1);
    expect(JSON.stringify(records)).not.toMatch(
      /Cafe Test|Unrelated Private Venue|synthetic-google-key|https:|Berlin/,
    );
  });

  it.each([
    ["geography_conflict", { ...mention, city: "Munich" }],
    ["address_conflict", { ...mention, addressHint: "Another Street" }],
    ["missing_geography", { ...mention, city: null, country: null }],
  ] as const)("reports %s separately", (reason, input) => {
    const records: DiagnosticRecord[] = [];
    selectPlaceMatch(input, [placeSchema.parse(place())], {
      allowPossible: true,
      onDecision: (record) => records.push(record),
    });
    expect(records[0].reason).toBe(reason);
  });

  it("separates absent photo metadata from failed photo requests", async () => {
    for (const hasPhoto of [false, true]) {
      const records: DiagnosticRecord[] = [];
      await withPlaces(
        { places: [{ ...place(), photos: hasPhoto ? place().photos : [] }] },
        async (match) => {
          await match(mention);
        },
        { photoStatus: 403, log: (record) => records.push(record) },
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          event: "places.photo_result",
          outcome: "omitted",
          reason: hasPhoto ? "all_photos_failed" : "no_photo_metadata",
        }),
      );
      if (hasPhoto)
        expect(records).toContainEqual(
          expect.objectContaining({
            event: "places.request_failed",
            stage: "photo",
            status: 403,
          }),
        );
    }
  });

  it("explains when a valid photo is omitted by the card credit layout", async () => {
    const result = selectPlaceMatch(mention, [placeSchema.parse(place())]);
    if (result.kind !== "matched") throw new Error("Expected fixture match");
    const records: DiagnosticRecord[] = [];
    await preparePlaceCards(
      { mentions: [mention] },
      async () => ({
        ...result,
        place: {
          ...result.place,
          imageUrl: "https://images.example.test/photo",
          photoCredits: [
            { displayName: "A", uri: "https://maps.google.com/contrib/a" },
            { displayName: "B", uri: "https://maps.google.com/contrib/b" },
          ],
        },
      }),
      (record) => records.push(record),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "instagram.place_card",
        image: 0,
        reason: "photo_credits_cannot_fit",
        outcome: "location",
      }),
    );
    expect(JSON.stringify(records)).not.toContain("https:");
  });

  it("records cache hits without logging the caption or cache key", async () => {
    const records: DiagnosticRecord[] = [];
    let extractions = 0;
    const extract = createCachedReelExtractor({
      extract: async () => {
        extractions++;
        return { kind: "no-place" };
      },
      cache: { get: async () => ({ kind: "no-place" }), put: async () => {} },
      log: (record) => records.push(record),
    });
    await extract({ title: "private caption", reel_video_id: "123456" });
    expect(extractions).toBe(0);
    expect(records).toEqual([
      {
        event: "instagram.caption_cache",
        outcome: "hit",
        result: "no-place",
      },
    ]);
    expect(JSON.stringify(records)).not.toMatch(/private caption|123456/);
  });
});
