import { describe, expect, it } from "vitest";
import { preparePlaceCards } from "../../src/features/instagram/place-cards";
import { googlePlaceIdSchema } from "../../src/features/places/google";

describe("place photo cards", () => {
  it("opens the credited source photo without separate credit messages", async () => {
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
          photoSourceUrl: "https://maps.google.com/maps/photo/one",
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
    expect(prepared.cards[0]?.element.default_action).toEqual({
      type: "web_url",
      url: "https://maps.google.com/maps/photo/one",
    });
    expect(prepared.texts).toEqual([]);
  });
});

describe("compact carousel results", () => {
  const mention = {
    name: "Kwan Kee Claypot",
    evidence: "Kwan Kee Claypot in Hong Kong",
    city: "Hong Kong",
    country: "China",
  };
  it.each(["ambiguous", "not-found", "unavailable"] as const)(
    "keeps %s places as contextual search cards",
    async (kind) => {
      const prepared = await preparePlaceCards(
        { mentions: [mention] },
        async () => ({ kind }),
      );
      expect(prepared.texts).toEqual([]);
      expect(prepared.cards).toHaveLength(1);
      const card = prepared.cards[0].element;
      expect(card.title).toBe(mention.name);
      expect(card.subtitle).toContain("Search results");
      expect(card.image_url).toBeUndefined();
      expect(card.buttons.map((button) => button.title)).toEqual([
        "Google Maps",
        "Apple Maps",
      ]);
      expect(card.buttons[0].url).toContain("Hong%20Kong");
      expect(card.buttons[0].url).not.toContain("query_place_id");
    },
  );

  it("keeps places with unknown geography in the carousel", async () => {
    const prepared = await preparePlaceCards({
      mentions: [{ ...mention, city: null, country: null }],
    });
    expect(prepared.cards[0].element.subtitle).toContain("Location unclear");
    expect(prepared.texts).toEqual([]);
  });

  it("retains a verified card without inventing a photo when credits cannot fit", async () => {
    const prepared = await preparePlaceCards(
      { mentions: [mention] },
      async () => ({
        kind: "matched",
        place: {
          id: googlePlaceIdSchema.parse("verified"),
          name: mention.name,
          address: "Hong Kong",
          confidence: "high",
          attributions: [],
          links: {
            googleMaps: "https://maps.google.com/?q=22,114",
            appleMaps: "https://maps.apple.com/?q=22,114",
          },
          imageUrl: "https://images.example.test/photo.jpg",
          photoCredits: [
            { displayName: "A", uri: "https://maps.google.com/contrib/a" },
            { displayName: "B", uri: "https://maps.google.com/contrib/b" },
          ],
        },
      }),
    );
    expect(prepared.cards[0].element.image_url).toBeUndefined();
    expect(prepared.cards[0].element.buttons).toHaveLength(2);
    expect(prepared.texts).toEqual([]);
  });
});
