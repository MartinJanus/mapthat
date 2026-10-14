import { describe, expect, it } from "vitest";
import { mention, place, withPlaces } from "./google-fixtures";

describe("contextual matching regressions", () => {
  it("accepts descriptor differences and bilingual business names", async () => {
    await withPlaces(
      { places: [place("a", "Mak Man Kee 麥文記")] },
      async (match) => {
        expect(
          await match({ ...mention, name: "Mak Man Kee Noodle Shop" }),
        ).toMatchObject({ kind: "matched", place: { confidence: "medium" } });
      },
    );
  });

  it("resolves compact handles without inventing a venue name", async () => {
    await withPlaces(
      { places: [place("a", "Ho Lee Fook")] },
      async (match, requests) => {
        expect(await match({ ...mention, name: "@holeefook" })).toMatchObject({
          kind: "matched",
          place: { name: "Ho Lee Fook" },
        });
        expect(requests[0]?.body).toMatchObject({
          textQuery: "holeefook, Berlin, Germany",
        });
      },
    );
  });

  it("keeps competing branches ambiguous even after descriptor normalization", async () => {
    await withPlaces(
      {
        places: [place("a", "Mak Man Kee"), place("b", "Mak Man Kee Noodles")],
      },
      async (match) => {
        expect(
          await match({ ...mention, name: "Mak Man Kee Noodle Shop" }),
        ).toEqual({ kind: "ambiguous" });
      },
    );
  });

  it("accepts Hong Kong country geography and contextual handle suffixes", async () => {
    await withPlaces(
      {
        places: [
          {
            ...place("a", "Ho Lee Fook"),
            addressComponents: [
              { longText: "Central", types: ["locality"] },
              { longText: "Hong Kong", shortText: "HK", types: ["country"] },
            ],
          },
        ],
      },
      async (match, requests) => {
        expect(
          await match({
            ...mention,
            name: "@holeefookhk",
            city: "Hong Kong",
            country: "Hong Kong",
          }),
        ).toMatchObject({ kind: "matched" });
        expect(requests[0]?.body).toMatchObject({
          textQuery: "holeefook, Hong Kong, Hong Kong",
        });
      },
    );
  });

  it("does not turn malformed photo metadata into a place lookup failure", async () => {
    await withPlaces(
      { places: [{ ...place(), photos: [{ name: "invalid-resource" }] }] },
      async (match) => {
        expect(await match(mention)).toMatchObject({ kind: "no-photo" });
      },
    );
  });

  it("does not discard valid candidates because a sibling is malformed", async () => {
    await withPlaces(
      { places: [{ displayName: { text: "Broken" } }, place()] },
      async (match) => {
        expect(await match(mention)).toMatchObject({ kind: "matched" });
      },
    );
  });

  it("records safe HTTP diagnostics without leaking the response or API key", async () => {
    const records: Readonly<Record<string, string | number>>[] = [];
    await withPlaces(
      {
        error: {
          message: "secret provider response",
          key: "synthetic-google-key",
        },
      },
      async (match) => {
        expect(await match(mention)).toEqual({ kind: "unavailable" });
      },
      { status: 403, log: (record) => records.push(record) },
    );
    expect(records).toContainEqual({
      event: "places.request_failed",
      stage: "search",
      reason: "http",
      status: 403,
    });
    expect(JSON.stringify(records)).not.toContain("synthetic-google-key");
    expect(JSON.stringify(records)).not.toContain("secret provider response");
  });
});
