import { describe, expect, it } from "vitest";
import { mention, place, withPlaces } from "./google-fixtures";

describe("Google Places matching", () => {
  it("omits an unsafe photo URI when the photo response contains a key", async () => {
    await withPlaces(
      {
        places: [
          {
            ...place(),
            photos: [
              { name: "places/place-1/photos/photo-1", authorAttributions: [] },
            ],
          },
        ],
      },
      async (match) => {
        const result = await match(mention);
        expect(result.kind).toBe("no-photo");
        if (result.kind !== "no-photo")
          throw new TypeError("Expected photo fallback");
        expect(result.place.imageUrl).toBeUndefined();
      },
      {
        photo: {
          photoUri:
            "https://images.example.test/photo.jpg?key=synthetic-google-key",
        },
      },
    );
  });

  it("returns all credits when the first photo has multiple authors", async () => {
    const photo = {
      name: "places/place-1/photos/photo-1",
      authorAttributions: [
        {
          displayName: "Author One",
          uri: "https://maps.google.com/contrib/one",
        },
        {
          displayName: "Author Two",
          uri: "https://maps.google.com/contrib/two",
        },
      ],
    };
    await withPlaces(
      { places: [{ ...place(), photos: [photo] }] },
      async (match, requests) => {
        const result = await match(mention);
        expect(result).toMatchObject({
          kind: "matched",
          place: {
            photoCredits: photo.authorAttributions,
            imageUrl: "https://images.example.test/first.jpg",
          },
        });
        expect(requests).toHaveLength(2);
      },
    );
  });

  it("matches a unique name and geography when Places returns a supported candidate", async () => {
    await withPlaces({ places: [place()] }, async (match, requests) => {
      const result = await match(mention);
      expect(result).toMatchObject({
        kind: "matched",
        place: {
          id: "place-1",
          confidence: "high",
          address: "Test Street, Berlin, Germany",
        },
      });
      if (result.kind !== "matched") throw new TypeError("Expected match");
      expect(
        new URL(result.place.links.googleMaps).searchParams.get(
          "query_place_id",
        ),
      ).toBe("place-1");
      expect(new URL(result.place.links.appleMaps).searchParams.get("ll")).toBe(
        "52.52,13.405",
      );
      expect(requests[0]).toMatchObject({
        path: "/v1/places:searchText",
        key: "synthetic-google-key",
        body: {
          textQuery: "Cafe Test, Berlin, Germany",
          pageSize: 20,
          languageCode: "en",
        },
      });
      expect(requests[0]?.mask).toContain("places.addressComponents");
    });
  });

  it.each([
    { places: [place("a"), place("b")] },
    { places: [place("a", "Cafe Test", "Munich")] },
    { places: [place("a", "Different Restaurant")] },
  ])(
    "does not select a location when the candidates are ambiguous or contradict the caption",
    async (search) => {
      await withPlaces(search, async (match) => {
        expect(await match(mention)).toEqual({ kind: "ambiguous" });
      });
    },
  );

  it("accepts a unique descriptor variation as a likely match", async () => {
    await withPlaces(
      { places: [place("a", "The Little Cafe Test Berlin")] },
      async (match) => {
        expect(
          await match({ ...mention, name: "Little Cafe Test Berlin" }),
        ).toMatchObject({ kind: "matched", place: { confidence: "medium" } });
      },
    );
  });

  it("avoids a provider request when the caption has no location context", async () => {
    await withPlaces({ places: [place()] }, async (match, requests) => {
      expect(await match({ ...mention, city: null, country: null })).toEqual({
        kind: "ambiguous",
      });
      expect(requests).toEqual([]);
    });
  });

  it("returns no match when the provider finds no places", async () => {
    await withPlaces({}, async (match) =>
      expect(await match(mention)).toEqual({ kind: "not-found" }),
    );
  });

  it.each([400, 403, 429, 500])(
    "reports HTTP %s as unavailable without retrying",
    async (status) => {
      await withPlaces(
        {},
        async (match, requests) => {
          expect(await match(mention)).toEqual({ kind: "unavailable" });
          expect(requests).toHaveLength(1);
        },
        { status },
      );
    },
  );

  it("rejects malformed Places output instead of constructing a location", async () => {
    await withPlaces(
      { places: [{ ...place(), location: { latitude: 1000, longitude: 0 } }] },
      async (match) =>
        expect(await match(mention)).toEqual({ kind: "unavailable" }),
    );
  });

  it("resolves an image URL privately when a matched place has a supported photo", async () => {
    const photo = {
      name: "places/place-1/photos/photo-1",
      authorAttributions: [
        { displayName: "Test Author", uri: "//maps.google.com/contrib/test" },
      ],
    };
    await withPlaces(
      { places: [{ ...place(), photos: [photo] }] },
      async (match, requests) => {
        const result = await match(mention);
        expect(result).toMatchObject({
          kind: "matched",
          place: {
            imageUrl: "https://images.example.test/photo.jpg",
            photoCredit: {
              displayName: "Test Author",
              uri: "https://maps.google.com/contrib/test",
            },
          },
        });
        expect(requests[1]).toMatchObject({
          path: "/v1/places/place-1/photos/photo-1/media?maxWidthPx=800&skipHttpRedirect=true",
          key: "synthetic-google-key",
        });
        expect(JSON.stringify(result)).not.toContain("synthetic-google-key");
      },
      { photo: { photoUri: "https://images.example.test/photo.jpg" } },
    );
  });

  it.each([403, 500])(
    "returns a photo fallback when the first photo request fails with %s",
    async (photoStatus) => {
      await withPlaces(
        {
          places: [
            {
              ...place(),
              photos: [
                {
                  name: "places/place-1/photos/photo-1",
                  authorAttributions: [],
                },
              ],
            },
          ],
        },
        async (match) => {
          const result = await match(mention);
          expect(result.kind).toBe("no-photo");
          if (result.kind !== "no-photo")
            throw new TypeError("Expected photo fallback");
          expect(result.place.imageUrl).toBeUndefined();
        },
        { photoStatus },
      );
    },
  );
});
