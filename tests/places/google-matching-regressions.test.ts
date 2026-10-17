import { describe, expect, it } from "vitest";
import { mention, place, withPlaces } from "./google-fixtures";
import { selectPlaceMatch } from "../../src/features/places/google";
import { placeSchema } from "../../src/features/places/google-model";

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

  it("labels competing branches as a possible match", async () => {
    await withPlaces(
      {
        places: [place("a", "Mak Man Kee"), place("b", "Mak Man Kee Noodles")],
      },
      async (match) => {
        expect(
          await match({ ...mention, name: "Mak Man Kee Noodle Shop" }),
        ).toMatchObject({
          kind: "matched",
          place: { id: "a", confidence: "possible" },
        });
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
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "places.request_failed",
        stage: "search",
        reason: "http",
        status: 403,
      }),
    );
    expect(JSON.stringify(records)).not.toContain("synthetic-google-key");
    expect(JSON.stringify(records)).not.toContain("secret provider response");
  });
});

describe("possible-match limits", () => {
  it.each([
    { name: "Different Restaurant", city: "Berlin", country: "Germany" },
    { name: "Cafe Test", city: "Munich", country: "Germany" },
  ])(
    "rejects contradictory candidates despite allowing guesses: %s",
    (candidate) => {
      const actual = placeSchema.parse(
        place("wrong", candidate.name, candidate.city),
      );
      expect(
        selectPlaceMatch(mention, [actual], { allowPossible: true }),
      ).toEqual({
        kind: "ambiguous",
      });
    },
  );

  it("does not ignore an explicit street or country to make a guess", () => {
    const actual = placeSchema.parse(place());
    for (const context of [
      { ...mention, addressHint: "Another Street" },
      { ...mention, country: "France" },
      { ...mention, city: null, country: null },
    ]) {
      expect(
        selectPlaceMatch(context, [actual], { allowPossible: true }),
      ).toEqual({ kind: "ambiguous" });
    }
  });
});

describe("district and neighborhood geography", () => {
  function candidate(area: string, type: string, country = "Hong Kong") {
    return placeSchema.parse({
      ...place("district-place", "Cafe Test"),
      formattedAddress: `1 Test Road, ${area}, ${country}`,
      addressComponents: [
        { longText: area, types: [type, "political"] },
        {
          longText: country,
          shortText: country === "Hong Kong" ? "HK" : "GB",
          types: ["country"],
        },
      ],
    });
  }

  it.each([
    "administrative_area_level_2",
    "administrative_area_level_3",
    "sublocality_level_1",
    "sublocality_level_2",
    "sublocality_level_3",
    "sublocality_level_4",
    "sublocality_level_5",
    "neighborhood",
  ])("accepts exact district evidence in a %s component", (type) => {
    expect(
      selectPlaceMatch(
        { ...mention, city: "Sheung Wan", country: "Hong Kong" },
        [candidate("Sheung Wan", type)],
      ),
    ).toMatchObject({
      kind: "matched",
      place: { id: "district-place", confidence: "high" },
    });
  });

  it.each([
    ["Kowloon City", "Kowloon City District"],
    ["Kowloon City District", "Kowloon City"],
  ])("matches the optional district label: %s to %s", (expected, actual) => {
    expect(
      selectPlaceMatch({ ...mention, city: expected, country: "Hong Kong" }, [
        candidate(actual, "administrative_area_level_2"),
      ]),
    ).toMatchObject({ kind: "matched" });
  });

  it("uses a district component's short text when the long text is localized", () => {
    const actual = candidate("九龍城區", "administrative_area_level_2");
    actual.addressComponents[0].shortText = "Kowloon City";
    expect(
      selectPlaceMatch(
        { ...mention, city: "Kowloon City", country: "Hong Kong" },
        [actual],
      ),
    ).toMatchObject({ kind: "matched" });
  });

  it.each([
    ["Sheung Wan", "Central", "Hong Kong", "neighborhood"],
    [
      "Central",
      "Central and Western District",
      "Hong Kong",
      "administrative_area_level_2",
    ],
    ["Central", "Central", "United Kingdom", "neighborhood"],
    ["Central", "Central", "Hong Kong", "route"],
    ["Central", "Central", "Hong Kong", "premise"],
    ["Central", "Central", "Hong Kong", "political"],
  ])(
    "rejects conflicting or unsupported geography: %s / %s / %s / %s",
    (expected, actual, country, type) => {
      expect(
        selectPlaceMatch(
          { ...mention, city: expected, country: "Hong Kong" },
          [candidate(actual, type, country)],
          { allowPossible: true },
        ),
      ).toEqual({ kind: "ambiguous" });
    },
  );

  it("preserves venue-name and street checks after accepting a district", () => {
    const actual = candidate("Central", "neighborhood");
    for (const context of [
      {
        ...mention,
        name: "Unrelated Venue",
        city: "Central",
        country: "Hong Kong",
      },
      {
        ...mention,
        addressHint: "Another Street",
        city: "Central",
        country: "Hong Kong",
      },
    ]) {
      expect(
        selectPlaceMatch(context, [actual], { allowPossible: true }),
      ).toEqual({ kind: "ambiguous" });
    }
  });

  it("does not treat a district name as country evidence", () => {
    const actual = candidate("Central", "neighborhood", "United Kingdom");
    expect(
      selectPlaceMatch({ ...mention, city: null, country: "Central" }, [
        actual,
      ]),
    ).toEqual({ kind: "ambiguous" });
  });

  it.each([
    ["Tai Wo Tang Cafe", "Kowloon City", "administrative_area_level_2"],
    ["Kactus Koffee", "Sheung Wan", "neighborhood"],
    ["Yukkuri", "Kowloon City", "sublocality_level_2"],
    ["Tai On Coffee", "Yau Ma Tei", "sublocality_level_1"],
    ["Lan Fong Yuen", "Central", "neighborhood"],
    ["Lau Haa Hotpot", "Causeway Bay", "neighborhood"],
  ])("continues to photo lookup for %s in %s", async (name, area, type) => {
    const actual = candidate(area, type);
    actual.displayName.text = name;
    const records: Readonly<Record<string, string | number>>[] = [];
    await withPlaces(
      { places: [actual] },
      async (match, requests) => {
        expect(
          await match({ ...mention, name, city: area, country: "Hong Kong" }),
        ).toMatchObject({
          kind: "matched",
          place: {
            id: actual.id,
            imageUrl: "https://images.example.test/first.jpg",
          },
        });
        expect(requests).toHaveLength(2);
        expect(records).toContainEqual(
          expect.objectContaining({
            event: "places.match_decision",
            geographyCount: 1,
            cityMatchCount: 1,
            countryMatchCount: 1,
          }),
        );
      },
      { log: (record) => records.push(record) },
    );
  });

  it("distinguishes a city mismatch from a country mismatch in safe diagnostics", () => {
    const records: Readonly<Record<string, string | number>>[] = [];
    selectPlaceMatch(
      { ...mention, city: "Sheung Wan", country: "Hong Kong" },
      [candidate("Central", "neighborhood")],
      { onDecision: (record) => records.push(record) },
    );
    expect(records[0]).toMatchObject({
      reason: "geography_conflict",
      cityMatchCount: 0,
      countryMatchCount: 1,
    });
    expect(JSON.stringify(records)).not.toMatch(/Sheung Wan|Central|Hong Kong/);
  });
});
