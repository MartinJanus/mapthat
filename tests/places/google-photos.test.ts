import { describe, expect, it } from "vitest";
import { mention, place, withPlaces } from "./google-fixtures";
import { preparePlaceCards } from "../../src/features/instagram/place-cards";

const firstPhoto = {
  name: "places/place-1/photos/first",
  googleMapsUri: "https://maps.google.com/maps/photo/first",
  authorAttributions: [
    {
      displayName: "A Photographer With A Long Display Name",
      uri: "https://maps.google.com/contrib/author",
    },
  ],
};
const secondPhoto = {
  name: "places/place-1/photos/second",
  authorAttributions: [],
};
const extraction = { mentions: [mention] };

describe("confident place photo cards", () => {
  it("displays the first Google photo when a confident match has multiple photos", async () => {
    await withPlaces(
      { places: [{ ...place(), photos: [firstPhoto, secondPhoto] }] },
      async (match, requests) => {
        const prepared = await preparePlaceCards(extraction, match);
        expect(requests[1]?.path).toBe(
          "/v1/places/place-1/photos/first/media?maxWidthPx=800&skipHttpRedirect=true",
        );
        expect(requests).toHaveLength(2);
        expect(prepared.cards[0]?.element).toMatchObject({
          image_url: "https://images.example.test/first.jpg",
          subtitle: "Google Maps · Test Street, Berlin, Germany",
        });
        expect(prepared.cards[0]?.element.default_action).toEqual({
          type: "web_url",
          url: firstPhoto.googleMapsUri,
        });
        expect(prepared.texts).toEqual([]);
        expect(
          prepared.cards[0]?.element.buttons.map((button) => button.title),
        ).toEqual(["Google Maps", "Apple Maps"]);
      },
    );
  });

  it("retains every author credit when the first photo has multiple authors", async () => {
    const authors = [
      ...firstPhoto.authorAttributions,
      {
        displayName: "Second Author",
        uri: "https://maps.google.com/contrib/second",
      },
    ];
    await withPlaces(
      {
        places: [
          {
            ...place(),
            photos: [{ ...firstPhoto, authorAttributions: authors }],
          },
        ],
      },
      async (match) => {
        const prepared = await preparePlaceCards(extraction, match);
        expect(prepared.cards[0]?.element.image_url).toBe(
          "https://images.example.test/first.jpg",
        );
        expect(prepared.cards[0]?.element.default_action?.url).toBe(
          firstPhoto.googleMapsUri,
        );
        expect(prepared.texts).toEqual([]);
        expect(prepared.cards[0]?.element.buttons).toHaveLength(2);
      },
    );
  });

  it("does not use photo availability to choose between indistinguishable branches", async () => {
    await withPlaces(
      { places: [{ ...place("a"), photos: [] }, place("b")] },
      async (match, requests) => {
        expect(await match(mention)).toMatchObject({
          kind: "no-photo",
          place: { id: "a", confidence: "possible" },
        });
        expect(requests).toHaveLength(1);
      },
    );
  });

  it("keeps the correct location when a different place has photos", async () => {
    await withPlaces(
      {
        places: [
          { ...place(), photos: [] },
          place("other", "Other Restaurant"),
        ],
      },
      async (match, requests) => {
        const prepared = await preparePlaceCards(extraction, match);
        expect(prepared.cards).toHaveLength(1);
        expect(prepared.cards[0]?.element.image_url).toBeUndefined();
        expect(prepared.cards[0]?.fallback).toContain("query_place_id=place-1");
        expect(requests).toHaveLength(1);
      },
    );
  });

  it("keeps a Maps card when all available photos fail", async () => {
    await withPlaces(
      { places: [{ ...place(), photos: [firstPhoto, secondPhoto] }] },
      async (match, requests) => {
        const prepared = await preparePlaceCards(extraction, match);
        expect(prepared.cards).toHaveLength(1);
        expect(prepared.cards[0]?.element.image_url).toBeUndefined();
        expect(prepared.cards[0]?.fallback).toContain(
          "Google Maps: https://www.google.com/maps/search/",
        );
        expect(prepared.cards[0]?.fallback).toContain(
          "Apple Maps: https://maps.apple.com/",
        );
        expect(requests[1]?.path).toContain("/photos/first/media");
        expect(requests).toHaveLength(3);
      },
      { photoStatus: 403 },
    );
  });

  it("marks a close competing name as possible and loads its own photo", async () => {
    await withPlaces(
      {
        places: [
          place("a", "Little Cafe Test Berlin"),
          place("b", "The Little Cafe Test Berlin"),
        ],
      },
      async (match, requests) => {
        expect(
          await match({ ...mention, name: "Little Cafe Test Berlin" }),
        ).toMatchObject({
          kind: "matched",
          place: { id: "a", confidence: "possible" },
        });
        expect(requests[1]?.path).toContain("/places/a/photos/");
        expect(requests).toHaveLength(2);
      },
    );
  });

  it("accepts capitalization, punctuation and accent differences when the location agrees", async () => {
    await withPlaces(
      { places: [place("place-1", "CAFÉ-TEST")] },
      async (match) => {
        expect(await match(mention)).toMatchObject({
          kind: "matched",
          place: {
            confidence: "high",
            imageUrl: "https://images.example.test/first.jpg",
          },
        });
      },
    );
  });

  it("does not mistake reordered words for an exact business name", async () => {
    await withPlaces(
      { places: [place("place-1", "Test Cafe")] },
      async (match) => {
        expect(await match(mention)).toEqual({ kind: "ambiguous" });
      },
    );
  });
});

describe("photo fallback within the selected place", () => {
  it("uses the next photo of the same place when its first photo fails", async () => {
    await withPlaces(
      { places: [{ ...place(), photos: [firstPhoto, secondPhoto] }] },
      async (match, requests) => {
        const result = await match(mention);
        expect(result).toMatchObject({
          kind: "matched",
          place: {
            id: "place-1",
            imageUrl: "https://images.example.test/second.jpg",
          },
        });
        expect(requests[1]?.path).toContain("/photos/first/media");
        expect(requests[2]?.path).toContain("/photos/second/media");
        expect(requests).toHaveLength(3);
      },
      {
        failedPhotoPaths: ["/v1/places/place-1/photos/first/media"],
        photo: { photoUri: "https://images.example.test/second.jpg" },
      },
    );
  });
});

describe("possible location photo cards", () => {
  it("keeps the candidate photo, address and both links together", async () => {
    await withPlaces(
      {
        places: [
          {
            ...place("candidate-a"),
            formattedAddress: "1 Main Street, Berlin",
          },
          {
            ...place("candidate-b"),
            formattedAddress: "9 Other Street, Berlin",
            location: { latitude: 52.6, longitude: 13.5 },
          },
        ],
      },
      async (match, requests) => {
        const prepared = await preparePlaceCards(extraction, match);
        const card = prepared.cards[0].element;
        expect(card.subtitle).toContain("Possible match · Check address");
        expect(card.subtitle).toContain("1 Main Street");
        expect(card.image_url).toBe("https://images.example.test/first.jpg");
        expect(card.buttons.map((button) => button.title)).toEqual([
          "Google Maps",
          "Apple Maps",
        ]);
        const google = new URL(card.buttons[0].url);
        const apple = new URL(card.buttons[1].url);
        expect(google.searchParams.get("query_place_id")).toBe("candidate-a");
        expect(google.searchParams.get("query")).toBe("52.52,13.405");
        expect(apple.searchParams.get("ll")).toBe("52.52,13.405");
        expect(requests[1].path).toContain("/places/candidate-a/photos/");
        expect(requests).toHaveLength(2);
        expect(prepared.texts).toEqual([]);
        expect(prepared.cards[0].fallback).toContain("Possible match");
      },
    );
  });

  it("retains the possible-match warning when the selected photo fails", async () => {
    await withPlaces(
      { places: [place("a"), place("b")] },
      async (match) => {
        const prepared = await preparePlaceCards(extraction, match);
        expect(prepared.cards[0].element.subtitle).toContain("Possible match");
        expect(prepared.cards[0].element.image_url).toBeUndefined();
        expect(prepared.cards[0].element.buttons).toHaveLength(2);
      },
      { photoStatus: 403 },
    );
  });
});
