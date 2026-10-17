import { vi } from "vitest";
import { TrackingUnavailableError } from "../../src/features/tracking/requests";
import type { RequestStore } from "../../src/features/tracking/requests";
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
  const deliveries: string[] = [];
  const cards: (readonly GenericElement[])[] = [];
  const reactions: { recipient: string; messageId: string }[] = [];
  const messenger: InstagramMessenger = {
    sendText: async (_, text) => {
      texts.push(text);
      deliveries.push("text");
      return { kind: "sent" };
    },
    reactToMessage: async (recipient, messageId) => {
      reactions.push({ recipient, messageId });
      return reactionResult;
    },
    sendGenericTemplate: async (_, elements) => {
      cards.push(elements);
      deliveries.push("carousel");
      return cardResult;
    },
  };
  return { messenger, texts, cards, reactions, deliveries };
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
    expect(recorded.texts).toHaveLength(4);
    expect(recorded.texts[3]).toContain("Not verified: Cafe One; Cafe Two");
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
    expect(summary).toEqual({ sent: 3, failed: 0, ignored: 0, duplicate: 0 });
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
      expect(recorded.texts).toHaveLength(3);
      expect(recorded.texts[2]).toContain("Not verified:");
      expect(recorded.texts[1]).toContain(
        "Google Maps: https://www.google.com/maps/search/",
      );
      expect(recorded.texts[1]).toContain(
        "Apple Maps: https://maps.apple.com/",
      );
      expect(summary).toMatchObject({ sent: 3, failed: 1 });
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
      expect(recorded.texts).toEqual([
        "Finding your locations…",
        "Not verified: Yat Lok Restaurant. Please double-check these locations before you go.",
      ]);
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

  it("replies once to non-Reel attachments", async () => {
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

    expect(summary).toEqual({ sent: 1, failed: 0, ignored: 0, duplicate: 0 });
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

describe("unsupported media replies", () => {
  it.each(["image", "video", "ig_post", "unknown"])(
    "responds once to incoming %s without extraction or reactions",
    async (type) => {
      const recorded = recordingMessenger();
      let extractions = 0;
      const process = createReelMessageProcessor({
        now: () => timestamp + 1000,
        extract: async () => {
          extractions++;
          return extracted;
        },
      });
      const input = batch([
        {
          ...event("unsupported"),
          message: { mid: "unsupported", attachments: [{ type }] },
        },
      ]);
      await process(input, account, recorded.messenger);
      const duplicate = await process(input, account, recorded.messenger);
      expect(recorded.texts).toHaveLength(1);
      expect(recorded.texts[0]).toContain("Instagram Reel");
      expect(recorded.texts[0]).not.toContain("Finding");
      expect(recorded.cards).toEqual([]);
      expect(recorded.reactions).toEqual([]);
      expect(extractions).toBe(0);
      expect(duplicate.duplicate).toBe(1);
    },
  );

  it("responds to Meta's unsupported flag without attachments", async () => {
    const recorded = recordingMessenger();
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => extracted,
    });
    await process(
      batch([
        {
          ...event("flagged"),
          message: { mid: "flagged", is_unsupported: true },
        },
      ]),
      account,
      recorded.messenger,
    );
    expect(recorded.texts).toHaveLength(1);
    expect(recorded.texts[0]).toContain("can't process");
  });

  it("does not reply to echoes, self/deleted messages, stale events or receipts", async () => {
    const recorded = recordingMessenger();
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => extracted,
    });
    const unsupported = { mid: "ignored", attachments: [{ type: "image" }] };
    await process(
      batch([
        { ...event("echo"), message: { ...unsupported, is_echo: true } },
        { ...event("self"), message: { ...unsupported, is_self: true } },
        { ...event("deleted"), message: { ...unsupported, is_deleted: true } },
        { ...event("own"), sender: { id: account }, message: unsupported },
        { ...event("wrong"), recipient: { id: "99999" }, message: unsupported },
        {
          ...event("stale"),
          timestamp: timestamp - 86400000,
          message: unsupported,
        },
        {
          ...event("future"),
          timestamp: timestamp + 10000,
          message: unsupported,
        },
        {
          sender: { id: "20002" },
          recipient: { id: account },
          timestamp,
          read: { watermark: timestamp },
        },
      ]),
      account,
      recorded.messenger,
    );
    expect(recorded.texts).toEqual([]);
    expect(recorded.reactions).toEqual([]);
  });

  it("processes a usable Reel in mixed attachments", async () => {
    const recorded = recordingMessenger();
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => extracted,
    });
    const incoming = event("mixed");
    await process(
      batch([
        {
          ...incoming,
          message: {
            ...incoming.message,
            attachments: [{ type: "image" }, ...incoming.message.attachments],
          },
        },
      ]),
      account,
      recorded.messenger,
    );
    expect(recorded.cards).toHaveLength(1);
    expect(recorded.texts.some((text) => text.includes("can't process"))).toBe(
      false,
    );
  });
});

describe("verification note after locations", () => {
  it("lists only uncertain locations after all carousel batches", async () => {
    const recorded = recordingMessenger();
    const names = [
      "Confirmed",
      "Likely",
      "Possible",
      "Search",
      ...Array.from({ length: 7 }, (_, i) => "Confirmed " + i),
    ];
    const mentions = names.map((name) => ({
      ...extracted.value.mentions[0],
      name,
    }));
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => ({ kind: "extracted", value: { mentions } }),
      match: async (mention) =>
        mention.name === "Search"
          ? { kind: "ambiguous" }
          : {
              kind: "no-photo",
              place: {
                id: googlePlaceIdSchema.parse(mention.name),
                name: mention.name,
                address: "Hong Kong",
                confidence:
                  mention.name === "Likely"
                    ? "medium"
                    : mention.name === "Possible"
                      ? "possible"
                      : "high",
                attributions: [],
                links: {
                  googleMaps: "https://maps.google.com/?q=22,114",
                  appleMaps: "https://maps.apple.com/?q=22,114",
                },
              },
            },
    });
    const input = batch([event("note")]);
    await process(input, account, recorded.messenger);
    await process(input, account, recorded.messenger);
    expect(recorded.cards.map((cards) => cards.length)).toEqual([10, 1]);
    expect(recorded.deliveries).toEqual([
      "text",
      "carousel",
      "carousel",
      "text",
    ]);
    expect(recorded.texts[1]).toBe(
      "Not verified: Likely; Possible; Search. Please double-check these locations before you go.",
    );
    expect(recorded.texts[1]).not.toContain("Confirmed");
    expect(
      recorded.cards.flat().every((card) => card.buttons.length === 2),
    ).toBe(true);
  });

  it("does not add a note when all matches are confident", async () => {
    const recorded = recordingMessenger();
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => extracted,
      match: async () => ({
        kind: "no-photo",
        place: {
          id: googlePlaceIdSchema.parse("confirmed"),
          name: "Confirmed",
          address: "Hong Kong",
          confidence: "high",
          attributions: [],
          links: {
            googleMaps: "https://maps.google.com/?q=22,114",
            appleMaps: "https://maps.apple.com/?q=22,114",
          },
        },
      }),
    });
    await process(batch([event("confident")]), account, recorded.messenger);
    expect(recorded.texts).toEqual(["Finding your locations…"]);
  });

  it("does not append a note for locations whose card and fallback both failed", async () => {
    const recorded = recordingMessenger({ kind: "failed", reason: "http" });
    const texts: string[] = [];
    const messenger: InstagramMessenger = {
      ...recorded.messenger,
      sendText: async (_, text) => {
        texts.push(text);
        return texts.length === 1
          ? { kind: "sent" }
          : { kind: "failed", reason: "http" };
      },
    };
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract: async () => extracted,
    });
    await process(batch([event("undelivered")]), account, messenger);
    expect(texts).toHaveLength(2);
    expect(texts.some((text) => text.startsWith("Not verified:"))).toBe(false);
  });
});

describe("durable request tracking in the Reel flow", () => {
  it("deduplicates redelivery after a processor restart before any replies or extraction", async () => {
    const claimed = new Set<string>();
    const complete = vi
      .fn<RequestStore["complete"]>()
      .mockResolvedValue(undefined);
    const requestStore: RequestStore = {
      begin: async ({ messageId }) => {
        if (claimed.has(messageId)) return false;
        claimed.add(messageId);
        return true;
      },
      complete,
    };
    const extract = vi.fn().mockResolvedValue(extracted);
    const recorded = recordingMessenger();
    const options = { now: () => timestamp + 1000, extract, requestStore };
    await createReelMessageProcessor(options)(
      batch([event("durable")]),
      account,
      recorded.messenger,
    );
    const result = await createReelMessageProcessor(options)(
      batch([event("durable")]),
      account,
      recorded.messenger,
    );
    expect(result.duplicate).toBe(1);
    expect(extract).toHaveBeenCalledOnce();
    expect(recorded.cards).toHaveLength(1);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][1].places[0].mention_name).toBe(
      "Yat Lok Restaurant",
    );
  });

  it("does not spend or send when the database cannot claim the request", async () => {
    const extract = vi.fn();
    const recorded = recordingMessenger();
    const process = createReelMessageProcessor({
      now: () => timestamp + 1000,
      extract,
      requestStore: {
        begin: async () => {
          throw new TrackingUnavailableError();
        },
        complete: async () => {},
      },
    });
    await expect(
      process(batch([event("unavailable")]), account, recorded.messenger),
    ).rejects.toBeInstanceOf(TrackingUnavailableError);
    expect(extract).not.toHaveBeenCalled();
    expect(recorded.texts).toHaveLength(0);
    expect(recorded.reactions).toHaveLength(0);
  });
});
