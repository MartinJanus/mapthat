import { TrackingUnavailableError } from "../../src/features/tracking/requests";
import type { RequestStore } from "../../src/features/tracking/requests";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWebhookHandlers } from "../../src/features/instagram/webhook";

const environment = {
  INSTAGRAM_VERIFY_TOKEN: "synthetic-verification-token",
  INSTAGRAM_APP_SECRET: "synthetic-app-secret",
  INSTAGRAM_ACCESS_TOKEN: "synthetic-access-token",
  INSTAGRAM_ACCOUNT_ID: "10001",
} as const;

function setup(env: unknown = environment, requestStore?: RequestStore) {
  const recipients: string[] = [];
  const records: Readonly<Record<string, string | number>>[] = [];
  const handlers = createWebhookHandlers({
    environment: () => env,
    requestStore,
    sender: () => async (recipient) => {
      recipients.push(recipient);
      return { kind: "sent" };
    },
    log: (record) => records.push(record),
  });
  return { ...handlers, recipients, records };
}

function verification(params: Record<string, string> = {}) {
  return new Request(
    `https://example.test/api/instagram/webhook?${new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": environment.INSTAGRAM_VERIFY_TOKEN,
      "hub.challenge": "000123",
      ...params,
    })}`,
  );
}

function notification(body: string, signature?: string) {
  return new Request("https://example.test/api/instagram/webhook", {
    method: "POST",
    body,
    headers:
      signature === undefined ? {} : { "X-Hub-Signature-256": signature },
  });
}

function sign(body: string) {
  return `sha256=${createHmac("sha256", environment.INSTAGRAM_APP_SECRET).update(body).digest("hex")}`;
}

describe("Instagram webhook verification", () => {
  it("accepts a nonempty verify token when it is shorter than sixteen characters", async () => {
    const handlers = setup({ INSTAGRAM_VERIFY_TOKEN: "sample" });
    const response = handlers.GET(
      verification({ "hub.verify_token": "sample" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("000123");
  });

  it("returns the exact challenge when the configured token matches", async () => {
    const handlers = setup();
    const response = handlers.GET(verification());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("000123");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("works when only verification configuration is present", () => {
    const handlers = setup({
      INSTAGRAM_VERIFY_TOKEN: environment.INSTAGRAM_VERIFY_TOKEN,
    });
    const response = handlers.GET(verification());
    expect(response.status).toBe(200);
  });

  it.each(["wrong", "synthetic-verification-tokex"])(
    "rejects a mismatched token %s",
    (token) => {
      const handlers = setup();
      const response = handlers.GET(
        verification({ "hub.verify_token": token }),
      );
      expect(response.status).toBe(403);
    },
  );

  it.each([
    ["hub.mode", "unsubscribe"],
    ["hub.verify_token", ""],
    ["hub.challenge", ""],
  ])("rejects invalid verification parameter %s", (key, value) => {
    const handlers = setup();
    const response = handlers.GET(verification({ [key]: value }));
    expect(response.status).toBe(400);
  });

  it("fails closed when verification configuration is absent", () => {
    const handlers = setup({});
    const response = handlers.GET(verification());
    expect(response.status).toBe(503);
  });
});

describe("Instagram webhook authentication", () => {
  const body = JSON.stringify({ object: "instagram", entry: [] });

  it("accepts a valid signature for the exact request bytes", async () => {
    const handlers = setup();
    const response = await handlers.POST(notification(body, sign(body)));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("EVENT_RECEIVED");
  });

  it.each([
    undefined,
    "sha256=bad",
    `sha256=${"0".repeat(64)}`,
    `sha1=${"0".repeat(64)}`,
  ])(
    "rejects missing or invalid signature %s before JSON parsing",
    async (signature) => {
      const handlers = setup();
      const response = await handlers.POST(notification("not JSON", signature));
      expect(response.status).toBe(403);
      expect(handlers.recipients).toEqual([]);
      expect(handlers.records).toEqual([]);
    },
  );

  it.each([`${body}\n`, body.replace("instagram", "instagrAm"), ` ${body}`])(
    "rejects changed bytes with an otherwise valid original signature",
    async (changed) => {
      const handlers = setup();
      const response = await handlers.POST(notification(changed, sign(body)));
      expect(response.status).toBe(403);
    },
  );

  it("preserves Unicode request bytes during authentication", async () => {
    const handlers = setup();
    const unicode = JSON.stringify({
      object: "instagram",
      entry: [],
      text: "Příliš 🗺️",
    });
    const response = await handlers.POST(notification(unicode, sign(unicode)));
    expect(response.status).toBe(200);
  });

  it.each(["not JSON", "null", "[]", '{"object":"instagram","entry":{}}'])(
    "rejects authenticated malformed JSON or envelopes %s",
    async (invalid) => {
      const handlers = setup();
      const response = await handlers.POST(
        notification(invalid, sign(invalid)),
      );
      expect(response.status).toBe(400);
      expect(handlers.recipients).toEqual([]);
    },
  );

  it("rejects an oversized body before parsing or sending", async () => {
    const handlers = setup();
    const oversized = "a".repeat(1024 * 1024 + 1);
    const response = await handlers.POST(
      notification(oversized, sign(oversized)),
    );
    expect(response.status).toBe(413);
    expect(handlers.recipients).toEqual([]);
  });

  it("fails closed with a generic response when configuration is missing", async () => {
    const handlers = setup({});
    const response = await handlers.POST(notification(body, sign(body)));
    expect(response.status).toBe(503);
    expect(JSON.stringify(handlers.records)).not.toContain(
      environment.INSTAGRAM_APP_SECRET,
    );
    expect(handlers.recipients).toEqual([]);
  });
});

it("returns 503 on a signed Reel when persistence cannot claim it", async () => {
  const handlers = setup(environment, {
    begin: async () => {
      throw new TrackingUnavailableError();
    },
    complete: async () => {},
  });
  const body = JSON.stringify({
    object: "instagram",
    entry: [
      {
        id: environment.INSTAGRAM_ACCOUNT_ID,
        messaging: [
          {
            sender: { id: "20002" },
            recipient: { id: environment.INSTAGRAM_ACCOUNT_ID },
            timestamp: Date.now(),
            message: {
              mid: "database-outage",
              attachments: [
                {
                  type: "ig_reel",
                  payload: { title: "Visit Cafe in Berlin" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const response = await handlers.POST(notification(body, sign(body)));
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("Request persistence unavailable");
  expect(handlers.recipients).toEqual([]);
  expect(handlers.records).toContainEqual(
    expect.objectContaining({ event: "instagram.persistence_failed" }),
  );
});
