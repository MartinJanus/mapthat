import { describe, expect, it } from "vitest";
import { instagramIdSchema } from "../../src/features/instagram/config";
import type { SendResult } from "../../src/features/instagram/client";
import {
  createMessageProcessor,
  envelopeSchema,
} from "../../src/features/instagram/messages";

const account = instagramIdSchema.parse("10001");
const timestamp = 1800000000000;

function event(mid: string, extra: Record<string, unknown> = {}) {
  return {
    sender: { id: "20002" },
    recipient: { id: account },
    timestamp,
    message: { mid, text: "synthetic private message", ...extra },
  };
}

function batch(
  messages: readonly unknown[],
  extraEntries: readonly unknown[] = [],
) {
  return envelopeSchema.parse({
    object: "instagram",
    entry: [{ id: account, messaging: messages }, ...extraEntries],
  });
}

function setup(
  options: { readonly now?: () => number; readonly maxEntries?: number } = {},
) {
  const recipients: string[] = [];
  const process = createMessageProcessor({
    now: () => timestamp + 1000,
    ...options,
  });
  const send = async (recipient: string): Promise<SendResult> => {
    recipients.push(recipient);
    return { kind: "sent" };
  };
  return { process, send, recipients };
}

describe("Instagram fixed replies", () => {
  it("replies to all ordinary messages across batched entries", async () => {
    const handlers = setup();
    const input = batch(
      [event("one"), event("two")],
      [{ id: account, messaging: [event("three")] }],
    );
    const result = await handlers.process(input, account, handlers.send);
    expect(result).toEqual({
      sent: 3,
      failed: 0,
      ignored: 0,
      duplicate: 0,
      capacity: 0,
    });
    expect(handlers.recipients).toEqual(["20002", "20002", "20002"]);
  });

  it.each([
    { is_echo: true },
    { is_self: true },
    { is_deleted: true },
    { is_unsupported: true },
    {
      attachments: [
        { type: "share", payload: { url: "https://example.test/redacted" } },
      ],
    },
  ])("ignores unsupported and echo message flags %j", async (flags) => {
    const handlers = setup();
    const result = await handlers.process(
      batch([event("one", flags)]),
      account,
      handlers.send,
    );
    expect(result.ignored).toBe(1);
    expect(handlers.recipients).toEqual([]);
  });

  it.each([
    { ...event("one"), sender: { id: account } },
    { ...event("one"), recipient: { id: "99999" } },
    { ...event("one"), timestamp: timestamp - 24 * 60 * 60 * 1000 },
    { ...event("one"), timestamp: timestamp + 2000 },
    { message: { mid: "one", text: "synthetic" } },
    { ...event("one"), message: { text: "synthetic" } },
    { ...event("one"), message: { mid: "one", text: 42 } },
    { ...event("one"), message: { mid: "one", text: "", is_echo: "false" } },
    { sender: { id: "20002" }, read: { watermark: timestamp } },
    null,
  ])(
    "ignores own senders, misrouted, expired, and malformed events %j",
    async (input) => {
      const handlers = setup();
      const result = await handlers.process(
        batch([input, event("valid")]),
        account,
        handlers.send,
      );
      expect(result.ignored).toBe(1);
      expect(result.sent).toBe(1);
      expect(handlers.recipients).toEqual(["20002"]);
    },
  );

  it("ignores foreign objects and entries", async () => {
    const handlers = setup();
    const input = envelopeSchema.parse({
      object: "page",
      entry: [{ id: account, messaging: [event("one")] }],
    });
    const result = await handlers.process(input, account, handlers.send);
    expect(result.ignored).toBe(1);
    expect(handlers.recipients).toEqual([]);
  });

  it("continues a batch when entries are malformed or belong to another account", async () => {
    const handlers = setup();
    const result = await handlers.process(
      batch([event("one")], [null, { id: "99999", messaging: [event("two")] }]),
      account,
      handlers.send,
    );
    expect(result.sent).toBe(1);
    expect(result.ignored).toBe(2);
  });

  it("sends once when the same message is duplicated in a batch", async () => {
    const handlers = setup();
    const result = await handlers.process(
      batch([event("one"), event("one")]),
      account,
      handlers.send,
    );
    expect(result.sent).toBe(1);
    expect(result.duplicate).toBe(1);
    expect(handlers.recipients).toHaveLength(1);
  });

  it("suppresses a later webhook delivery after a successful send", async () => {
    const handlers = setup();
    await handlers.process(batch([event("one")]), account, handlers.send);
    const result = await handlers.process(
      batch([event("one")]),
      account,
      handlers.send,
    );
    expect(result.duplicate).toBe(1);
    expect(handlers.recipients).toHaveLength(1);
  });

  it("reserves messages before sending when duplicate deliveries overlap", async () => {
    const handlers = setup();
    const results = await Promise.all([
      handlers.process(batch([event("one")]), account, handlers.send),
      handlers.process(batch([event("one")]), account, handlers.send),
    ]);
    expect(
      results.map((result) => result.sent).reduce((a, b) => a + b, 0),
    ).toBe(1);
    expect(handlers.recipients).toHaveLength(1);
  });

  it("retains reservations when a failed send has uncertain delivery", async () => {
    const handlers = setup();
    await handlers.process(batch([event("one")]), account, async () => ({
      kind: "failed",
      reason: "transport",
    }));
    const result = await handlers.process(
      batch([event("one")]),
      account,
      handlers.send,
    );
    expect(result.duplicate).toBe(1);
    expect(handlers.recipients).toEqual([]);
  });

  it("fails closed at capacity without evicting previous attempts", async () => {
    const handlers = setup({ maxEntries: 1 });
    const result = await handlers.process(
      batch([event("one"), event("two"), event("one")]),
      account,
      handlers.send,
    );
    expect(result).toEqual({
      sent: 1,
      failed: 0,
      ignored: 0,
      duplicate: 1,
      capacity: 1,
    });
    expect(handlers.recipients).toHaveLength(1);
  });

  it("reclaims expired reservations for new messages", async () => {
    let time = timestamp + 1000;
    const handlers = setup({ now: () => time, maxEntries: 1 });
    await handlers.process(batch([event("one")]), account, handlers.send);
    time += 36 * 60 * 60 * 1000;
    const result = await handlers.process(
      batch([{ ...event("two"), timestamp: time }]),
      account,
      handlers.send,
    );
    expect(result.sent).toBe(1);
    expect(result.capacity).toBe(0);
  });
});
