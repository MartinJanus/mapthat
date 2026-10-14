import { describe, expect, it } from "vitest";
import { preparePlaceCards } from "../../src/features/instagram/place-cards";
import { googlePlaceIdSchema } from "../../src/features/places/google";

describe("place photo cards", () => {
  it("keeps the address and photo while crediting every author in full", async () => {
    const credits = [
      {
        displayName: "A Photographer With A Long Name",
        uri: "https://maps.google.com/contrib/one",
      },
      {
        displayName: "Another Photographer",
        uri: "https://maps.google.com/contrib/two",
      },
    ];
    const prepared = await preparePlaceCards(
      {
        mentions: [
          {
            name: "Cafe Test",
            city: "Berlin",
            country: "Germany",
            evidence: "Cafe Test in Berlin",
          },
        ],
      },
      async () => ({
        kind: "matched",
        place: {
          id: googlePlaceIdSchema.parse("place-1"),
          name: "Cafe Test",
          address: "Test Street, Berlin",
          confidence: "medium",
          links: {
            googleMaps:
              "https://www.google.com/maps/search/?api=1&query_place_id=place-1",
            appleMaps: "https://maps.apple.com/?ll=52.52,13.405",
          },
          imageUrl: "https://images.example.test/photo.jpg",
          photoCredit: credits[0],
          photoCredits: credits,
          attributions: [],
        },
      }),
    );
    expect(prepared.cards[0]?.element).toMatchObject({
      image_url: "https://images.example.test/photo.jpg",
      subtitle: "Google Maps · Likely match · Test Street, Berlin",
    });
    expect(prepared.cards[0]?.element.buttons).toHaveLength(2);
    expect(prepared.cards[0]?.attributions).toEqual(
      credits.map((credit) => `Photo of Cafe Test by ${credit.displayName}: ${credit.uri}`),
    );
  });
});
