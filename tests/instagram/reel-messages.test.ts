import { describe, expect, it } from "vitest";
import { instagramIdSchema } from "../../src/features/instagram/config";
import { envelopeSchema } from "../../src/features/instagram/messages";
import { createReelMessageProcessor } from "../../src/features/instagram/reel-messages";
import type {
  GenericElement,
  InstagramMessenger,
  SendResult,
} from "../../src/features/instagram/client";
import { splitMessageText } from "../../src/features/instagram/place-cards";
import { googlePlaceIdSchema } from "../../src/features/places/google";

const account = instagramIdSchema.parse("10001");
const timestamp = 1800000000000;

function event(mid: string, title = "Visit Yat Lok Restaurant in Hong Kong") {
  return {
    sender: { id: "20002" },
    recipient: { id: account },
    timestamp,
    message: {
      mid,
      attachments: [
        {
          type: "ig_reel",
          payload: { title },
        },
      ],
    },
  };
}

function batch(messages: readonly unknown[]) {
  return envelopeSchema.parse({
    object: "instagram",
    entry: [{ id: account, messaging: messages }],
  });
}

const extracted = {
  kind: "extracted" as const,
  value: {
    mentions: [
      {
        name: "Yat Lok Restaurant",
        evidence: "Visit Yat Lok Restaurant in Hong Kong",
        city: "Hong Kong",
        country: "China",
      },
    ],
  },
};

function recordingMessenger(
  cardResult: SendResult = { kind: "sent" },
  reactionResult: SendResult = { kind: "sent" },
) {
  const texts: string[] = [];
  const cards: (readonly GenericElement[])[] = [];
  const reactions: { recipient: string; messageId: string }[] = [];
  const messenger: InstagramMessenger = {
    sendText: async (_, text) => {
      texts.push(text);
      return { kind: "sent" };
    },
    reactToMessage: async (recipient, messageId) => {
      reactions.push({ recipient, messageId });
      return reactionResult;
    },
    sendGenericTemplate: async (_, elements) => {
      cards.push(elements);
      return cardResult;
    },
  };
  return { messenger, texts, cards, reactions };
}

describe("Instagram Reel replies", () => {
  it("preserves clickable links in the text fallback when Unicode place names produce large queries", async () => {
    const recorded = recordingMessenger({ kind: "failed", reason: "http" });
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => ({
        kind: "extracted",
        value: {
          mentions: [
            {
              name: "界".repeat(200),
              city: "京".repeat(120),
              country: "国".repeat(120),
              evidence: "example",
            },
          ],
        },
      }),
    });
    await process(batch([event("long")]), account, recorded.messenger);
    expect(
      recorded.texts.every((text) => Buffer.byteLength(text, "utf8") <= 1000),
    ).toBe(true);
    for (const button of recorded.cards[0]?.[0]?.buttons ?? []) {
      expect(recorded.texts.some((text) => text.includes(button.url))).toBe(
        true,
      );
      expect(
        new URL(button.url).searchParams.get("query") ??
          new URL(button.url).searchParams.get("q"),
      ).toContain("界");
    }
  });

  it("falls back for every place when a multiple-place carousel is rejected", async () => {
    const recorded = recordingMessenger({ kind: "failed", reason: "http" });
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => ({
        kind: "extracted",
        value: {
          mentions: [
            {
              name: "Cafe One",
              city: "Berlin",
              country: "Germany",
              evidence: "Cafe One",
            },
            {
              name: "Cafe Two",
              city: "Berlin",
              country: "Germany",
              evidence: "Cafe Two",
            },
          ],
        },
      }),
    });
    await process(
      batch([event("multiple-fallback")]),
      account,
      recorded.messenger,
    );
    expect(recorded.cards[0]).toHaveLength(2);
    expect(recorded.texts).toHaveLength(3);
    expect(recorded.texts[1]).toContain("Cafe One");
    expect(recorded.texts[2]).toContain("Cafe Two");
  });

  it("includes confidence, a photo and author credit when a place is matched", async () => {
    const recorded = recordingMessenger();
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => extracted,
      match: async () => ({
        kind: "matched",
        place: {
          id: googlePlaceIdSchema.parse("matched-place"),
          name: "Yat Lok Restaurant",
          address: "Hong Kong",
          confidence: "high",
          links: {
            googleMaps:
              "https://www.google.com/maps/search/?api=1&query_place_id=matched-place&query=22,114",
            appleMaps: "https://maps.apple.com/?q=22,114&ll=22,114",
          },
          imageUrl: "https://images.example.test/photo.jpg",
          photoCredit: {
            displayName: "Test Author",
            uri: "https://maps.google.com/contrib/test",
          },
          attributions: [],
        },
      }),
    });
    await process(batch([event("photo")]), account, recorded.messenger);
    expect(recorded.cards[0]?.[0]).toMatchObject({
      image_url: "https://images.example.test/photo.jpg",
      subtitle: "Google Maps · Hong Kong · Photo: Test Author",
      default_action: {
        type: "web_url",
        url: "https://maps.google.com/contrib/test",
      },
      buttons: [
        {
          title: "Google Maps",
          url: "https://www.google.com/maps/search/?api=1&query_place_id=matched-place&query=22,114",
        },
        {
          title: "Apple Maps",
          url: "https://maps.apple.com/?q=22,114&ll=22,114",
        },
      ],
    });
  });

  it("sends one card with both Maps buttons when the caption identifies one place", async () => {
    const recorded = recordingMessenger();
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => extracted,
    });
    const summary = await process(
      batch([event("one")]),
      account,
      recorded.messenger,
    );
    expect(recorded.reactions).toEqual([
      { recipient: "20002", messageId: "one" },
    ]);
    expect(summary).toEqual({ sent: 2, failed: 0, ignored: 0, duplicate: 0 });
    expect(recorded.cards).toHaveLength(1);
    expect(recorded.cards[0]).toHaveLength(1);
    expect(recorded.cards[0]?.[0]).toMatchObject({
      title: "Yat Lok Restaurant",
      subtitle: "Caption candidate (not verified) · Hong Kong · China",
      buttons: [
        {
          type: "web_url",
          title: "Google Maps",
          url: "https://www.google.com/maps/search/?api=1&query=Yat%20Lok%20Restaurant%2C%20Hong%20Kong%2C%20China",
        },
        {
          type: "web_url",
          title: "Apple Maps",
          url: "https://maps.apple.com/?q=Yat%20Lok%20Restaurant%2C%20Hong%20Kong%2C%20China",
        },
      ],
    });
  });

  it("splits multiple place cards into carousels of at most ten when there are eleven places", async () => {
    const recorded = recordingMessenger();
    const mentions = Array.from({ length: 11 }, (_, index) => ({
      name: `Place ${index}`,
      city: "Berlin",
      country: "Germany",
      evidence: `Place ${index}`,
    }));
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => ({ kind: "extracted", value: { mentions } }),
    });
    await process(batch([event("many")]), account, recorded.messenger);
    expect(recorded.cards.map((cards) => cards.length)).toEqual([10, 1]);
    expect(recorded.cards.flat().map((card) => card.title)).toEqual(
      mentions.map((mention) => mention.name),
    );
  });

  it.each(["http", "transport", "response"] as const)(
    "sends text links when a card fails with %s",
    async (reason) => {
      const recorded = recordingMessenger({ kind: "failed", reason });
      const process = createReelMessageProcessor({
        now: () => timestamp + 1000,
        extract: async () => extracted,
      });
      const summary = await process(
        batch([event("fallback")]),
        account,
        recorded.messenger,
      );
      expect(recorded.texts).toHaveLength(2);
      expect(recorded.texts[1]).toContain(
        "Google Maps: https://www.google.com/maps/search/",
      );
      expect(recorded.texts[1]).toContain(
        "Apple Maps: https://maps.apple.com/",
      );
      expect(summary).toMatchObject({ sent: 2, failed: 1 });
    },
  );

  it("continues with cards when the reaction is unsupported", async () => {
    const recorded = recordingMessenger(
      { kind: "sent" },
      { kind: "failed", reason: "http" },
    );
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => extracted,
    });
    await process(
      batch([event("reaction-failed")]),
      account,
      recorded.messenger,
    );
    expect(recorded.cards).toHaveLength(1);
  });

  it("does not react, match or send twice when Meta redelivers a Reel", async () => {
    const recorded = recordingMessenger();
    let matches = 0;
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => extracted,
      match: async () => {
        matches++;
        return { kind: "ambiguous" };
      },
    });
    await process(
      batch([event("duplicate"), event("duplicate")]),
      account,
      recorded.messenger,
    );
    expect(recorded.reactions).toHaveLength(1);
    expect(matches).toBe(1);
  });

  it.each(["ambiguous", "not-found", "unavailable"] as const)(
    "keeps an unverified search card when matching is %s",
    async (kind) => {
      const recorded = recordingMessenger();
      const process = createReelMessageProcessor({
        now: () => timestamp + 1000,
        extract: async () => extracted,
        match: async () => ({ kind }),
      });
      await process(batch([event("unmatched")]), account, recorded.messenger);
      expect(recorded.cards[0]).toHaveLength(1);
      expect(recorded.texts).toEqual(["Finding your locations…"]);
      expect(recorded.cards[0]?.[0]?.subtitle).toContain("Search results");
      expect(recorded.cards[0]?.[0]?.image_url).toBeUndefined();
      expect(recorded.cards[0]?.[0]?.buttons).toHaveLength(2);
    },
  );

  it("splits long fallback text on UTF-8 boundaries when a result exceeds the message byte limit", () => {
    const text = "🗺️".repeat(300);
    const parts = splitMessageText(text);
    expect(parts.join("")).toBe(text);
    expect(parts.every((part) => Buffer.byteLength(part, "utf8") <= 1000)).toBe(
      true,
    );
    expect(parts).toHaveLength(3);
  });

  it("acknowledges a Reel and sends Maps links for caption candidates", async () => {
    const sent: string[] = [];
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => extracted,
    });

    const summary = await process(
      batch([event("reel")]),
      account,
      async (_, text) => {
        sent.push(text);
        return { kind: "sent" };
      },
    );

    expect(summary).toEqual({ sent: 2, failed: 0, ignored: 0, duplicate: 0 });
    expect(sent).toEqual([
      "Finding your locations…",
      "1. Yat Lok Restaurant\nGoogle Maps: https://www.google.com/maps/search/?api=1&query=Yat%20Lok%20Restaurant%2C%20Hong%20Kong%2C%20China\nApple Maps: https://maps.apple.com/?q=Yat%20Lok%20Restaurant%2C%20Hong%20Kong%2C%20China",
    ]);
  });

  it("reports when the caption has no identifiable place", async () => {
    const sent: string[] = [];
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => ({ kind: "no-place" }),
    });

    await process(batch([event("reel")]), account, async (_, text) => {
      sent.push(text);
      return { kind: "sent" };
    });

    expect(sent).toEqual([
      "Finding your locations…",
      "I couldn't find a place recommendation in that Reel's caption.",
    ]);
  });

  it("does not spend another Gemini request when Meta redelivers a Reel", async () => {
    let extractions = 0;
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => {
        extractions++;
        return extracted;
      },
    });

    await process(batch([event("reel"), event("reel")]), account, async () => ({
      kind: "sent",
    }));

    expect(extractions).toBe(1);
  });

  it("ignores non-Reel attachments", async () => {
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => extracted,
    });
    const input = batch([
      {
        ...event("post"),
        message: { mid: "post", attachments: [{ type: "ig_post" }] },
      },
    ]);

    const summary = await process(input, account, async () => ({
      kind: "sent",
    }));

    expect(summary).toEqual({ sent: 0, failed: 0, ignored: 1, duplicate: 0 });
  });
});

describe("captionless media intake", () => {
  it("passes a captionless Reel to video fallback and sends a verified photo card", async () => {
    const recorded = recordingMessenger();
    const incoming = event("captionless", "");
    const payload: { title?: string; url?: string } =
      incoming.message.attachments[0].payload;
    delete payload.title;
    payload.url = "https://video.cdninstagram.com/example.mp4";
    let captionCalls = 0;
    let videoCalls = 0;
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => {
        captionCalls++;
        return { kind: "no-place" };
      },
      video: async (input) => {
        videoCalls++;
        expect(input.url).toBe(payload.url);
        return extracted;
      },
      match: async () => ({
        kind: "matched",
        place: {
          id: googlePlaceIdSchema.parse("verified"),
          name: "Yat Lok Restaurant",
          address: "Hong Kong",
          confidence: "high",
          links: {
            googleMaps: "https://maps.google.com/?q=22,114",
            appleMaps: "https://maps.apple.com/?q=22,114",
          },
          imageUrl: "https://images.example.test/verified.jpg",
          attributions: [],
        },
      }),
    });
    await process(batch([incoming]), account, recorded.messenger);
    expect(captionCalls).toBe(0);
    expect(videoCalls).toBe(1);
    expect(recorded.cards[0]?.[0]).toMatchObject({
      image_url: "https://images.example.test/verified.jpg",
    });
  });
});
