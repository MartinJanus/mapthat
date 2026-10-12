import { createServer } from "node:http";
import { once } from "node:events";
import ky from "ky";
import { describe, expect, it } from "vitest";
import { createGooglePlacesMatcher } from "../../src/features/places/google";
import type { MatchPlace } from "../../src/features/places/google";

const mention = {
  name: "Cafe Test",
  city: "Berlin",
  country: "Germany",
  evidence: "Cafe Test in Berlin, Germany",
};
function place(id = "place-1", name = "Cafe Test", city = "Berlin") {
  return {
    id,
    displayName: { text: name },
    formattedAddress: `Test Street, ${city}, Germany`,
    location: { latitude: 52.52, longitude: 13.405 },
    addressComponents: [
      { longText: city, types: ["locality"] },
      { longText: "Germany", shortText: "DE", types: ["country"] },
    ],
    photos: [],
  };
}

type ObservedRequest = {
  readonly path: string | undefined;
  readonly key: string | string[] | undefined;
  readonly mask: string | string[] | undefined;
  readonly body: unknown;
};
async function withPlaces(
  search: unknown,
  run: (match: MatchPlace, requests: ObservedRequest[]) => Promise<void>,
  options: {
    readonly status?: number;
    readonly photo?: unknown;
    readonly photoStatus?: number;
  } = {},
) {
  const requests: ObservedRequest[] = [];
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      path: request.url,
      key: request.headers["x-goog-api-key"],
      mask: request.headers["x-goog-fieldmask"],
      body: body ? JSON.parse(body) : undefined,
    });
    const photo = request.method === "GET";
    reply.writeHead(
      photo ? (options.photoStatus ?? 200) : (options.status ?? 200),
      { "Content-Type": "application/json" },
    );
    reply.end(JSON.stringify(photo ? options.photo : search));
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string")
    throw new TypeError("Expected TCP address");
  const http = ky.create({
    hooks: {
      beforeRequest: [
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.origin).toBe("https://places.googleapis.com");
          return new Request(
            `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
            request,
          );
        },
      ],
    },
  });
  try {
    await run(
      createGooglePlacesMatcher(
        { GOOGLE_PLACES_API_KEY: "synthetic-google-key" },
        http,
      ),
      requests,
    );
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

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
        expect(result.kind).toBe("matched");
        if (result.kind !== "matched") throw new TypeError("Expected match");
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

  it("omits photos requiring more author credit buttons than the card supports", async () => {
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
        expect(result.kind).toBe("matched");
        expect(requests).toHaveLength(1);
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
          pageSize: 5,
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

  it("assigns medium confidence when the name overlap is strong but not exact", async () => {
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
    "retains a match without an image when the photo request fails with %s",
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
          expect(result.kind).toBe("matched");
          if (result.kind !== "matched") throw new TypeError("Expected match");
          expect(result.place.imageUrl).toBeUndefined();
        },
        { photoStatus },
      );
    },
  );
});
