import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReelCapture } from "../../src/features/instagram/reel-capture";
import { createWebhookHandlers } from "../../src/features/instagram/webhook";

const now = 1800000000000;
const environment = {
  INSTAGRAM_APP_SECRET: "synthetic-secret",
  INSTAGRAM_ACCESS_TOKEN: "synthetic-token",
  INSTAGRAM_ACCOUNT_ID: "10001",
};

function event(
  mid: string,
  message: Readonly<Record<string, unknown>>,
  sender = "20002",
  timestamp = now,
) {
  return {
    sender: { id: sender },
    recipient: { id: "10001" },
    timestamp,
    message: { mid, ...message },
  };
}

const reel = {
  attachments: [
    {
      type: "ig_reel",
      payload: {
        reel_video_id: "30003",
        title: "A full caption, retained exactly as Meta sent it.",
        url: "https://www.instagram.com/reel/any-reel-code/",
      },
    },
  ],
};

function setup(failWrite = false) {
  const records: Readonly<Record<string, unknown>>[] = [];
  const logs: Readonly<Record<string, string | number>>[] = [];
  const captureReel = createReelCapture({
    now: () => now,
    write: async (record) => {
      if (failWrite) throw new RangeError("filesystem unavailable");
      records.push(record);
    },
  });
  const handlers = createWebhookHandlers({
    environment: () => environment,
    captureReel,
    log: (record) => logs.push(record),
  });

  return {
    records,
    logs,
    async deliver(events: readonly unknown[], validSignature = true) {
      const body = JSON.stringify({
        object: "instagram",
        entry: [{ id: "10001", messaging: events }],
      });
      const signature = createHmac("sha256", environment.INSTAGRAM_APP_SECRET)
        .update(body)
        .digest("hex");
      return handlers.POST(
        new Request("https://example.test/api/instagram/webhook", {
          method: "POST",
          body,
          headers: {
            "X-Hub-Signature-256": `sha256=${validSignature ? signature : "0".repeat(64)}`,
          },
        }),
      );
    },
  };
}

describe("signature-verified Reel capture", () => {
  it("captures every incoming Reel as the full webhook entry", async () => {
    const test = setup();
    const incoming = event("reel", reel);

    const response = await test.deliver([incoming]);

    expect(response.status).toBe(200);
    expect(test.records).toEqual([
      {
        capturedAt: new Date(now).toISOString(),
        apiVersion: "v25.0",
        source: "signature-verified-webhook",
        webhook: {
          object: "instagram",
          entry: [{ id: "10001", messaging: [incoming] }],
        },
      },
    ]);
  });

  it("captures an unfamiliar Reel and suppresses duplicate delivery", async () => {
    const test = setup();
    const unfamiliar = event("different-reel", {
      attachments: [{ type: "ig_reel", payload: { title: "Any Reel" } }],
    });

    await test.deliver([unfamiliar, unfamiliar]);

    expect(test.records).toHaveLength(1);
  });

  it("does not capture unsigned, non-Reel, echoed, foreign, or expired events", async () => {
    const test = setup();
    await test.deliver([event("unsigned", reel)], false);
    await test.deliver([
      event("post", { attachments: [{ type: "ig_post" }] }),
      event("echo", { ...reel, is_echo: true }),
      { ...event("foreign", reel), recipient: { id: "99999" } },
      event("expired", reel, "20002", now - 24 * 60 * 60 * 1000),
    ]);

    expect(test.records).toEqual([]);
  });

  it("keeps webhook delivery successful when local capture fails", async () => {
    const test = setup(true);

    const response = await test.deliver([event("reel", reel)]);

    expect(response.status).toBe(200);
    expect(test.logs).toContainEqual({
      event: "instagram.reel_capture_failed",
      level: "error",
    });
  });
});
