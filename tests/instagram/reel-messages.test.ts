import { describe, expect, it } from "vitest";
import { instagramIdSchema } from "../../src/features/instagram/config";
import { envelopeSchema } from "../../src/features/instagram/messages";
import { createReelMessageProcessor } from "../../src/features/instagram/reel-messages";

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

describe("Instagram Reel replies", () => {
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
