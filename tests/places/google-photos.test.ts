import { describe, expect, it } from "vitest";
import { mention, place, withPlaces } from "./google-fixtures";
import { preparePlaceCards } from "../../src/features/instagram/place-cards";

const firstPhoto = {
  name: "places/place-1/photos/first",
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
        expect(prepared.cards[0]?.attributions).toEqual([
          "Photo of Cafe Test by A Photographer With A Long Display Name: https://maps.google.com/contrib/author",
        ]);
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
        expect(prepared.cards[0]?.attributions).toEqual([
          "Photo of Cafe Test by A Photographer With A Long Display Name: https://maps.google.com/contrib/author",
          "Photo of Cafe Test by Second Author: https://maps.google.com/contrib/second",
        ]);
      },
    );
  });

  it("does not use photo availability to choose between indistinguishable branches", async () => {
    await withPlaces(
      { places: [{ ...place("a"), photos: [] }, place("b")] },
      async (match, requests) => {
        expect(await match(mention)).toEqual({ kind: "ambiguous" });
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

  it("requires stronger evidence when a nearly identical competing name exists", async () => {
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
        ).toEqual({ kind: "ambiguous" });
        expect(requests).toHaveLength(1);
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
