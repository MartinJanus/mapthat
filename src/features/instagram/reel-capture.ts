import { z } from "zod";
import { instagramIdSchema } from "./config";
import type { WebhookConfig } from "./config";
import { saveReelCapture } from "./evidence-store";
import type { envelopeSchema } from "./messages";

const entrySchema = z.object({
  id: instagramIdSchema,
  messaging: z.array(z.unknown()),
});
const eventSchema = z.object({
  sender: z.object({ id: instagramIdSchema }),
  recipient: z.object({ id: instagramIdSchema }),
  timestamp: z.number().int().nonnegative(),
  message: z.object({
    mid: z.string().min(1),
    attachments: z.array(z.unknown()).optional(),
    is_echo: z.boolean().optional(),
    is_self: z.boolean().optional(),
    is_deleted: z.boolean().optional(),
  }),
});
const reelAttachmentSchema = z.object({ type: z.literal("ig_reel") });

const EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEDUPLICATION_RETENTION_MS = 36 * 60 * 60 * 1000;

export function createReelCapture(
  options: {
    readonly write?: typeof saveReelCapture;
    readonly now?: () => number;
  } = {},
) {
  const write = options.write ?? saveReelCapture;
  const now = options.now ?? Date.now;
  const seen = new Map<string, number>();

  return async (
    envelope: z.infer<typeof envelopeSchema>,
    config: WebhookConfig,
  ) => {
    if (envelope.object !== "instagram") return;
    removeExpiredMessages(seen, now());

    for (const rawEntry of envelope.entry) {
      const entry = entrySchema.safeParse(rawEntry);
      if (!entry.success || entry.data.id !== config.INSTAGRAM_ACCOUNT_ID)
        continue;

      for (const rawEvent of entry.data.messaging) {
        const event = eventSchema.safeParse(rawEvent);
        if (!event.success || !isIncomingReel(event.data, config, now()))
          continue;

        const key = `${event.data.sender.id}:${event.data.message.mid}`;
        if (seen.has(key) || seen.size >= 1000) continue;
        seen.set(key, now() + DEDUPLICATION_RETENTION_MS);

        await write({
          capturedAt: new Date(now()).toISOString(),
          apiVersion: config.INSTAGRAM_API_VERSION,
          source: "signature-verified-webhook",
          webhook: { object: envelope.object, entry: [rawEntry] },
        });
      }
    }
  };
}

function removeExpiredMessages(seen: Map<string, number>, timestamp: number) {
  for (const [message, expires] of seen) {
    if (expires <= timestamp) seen.delete(message);
  }
}

function isIncomingReel(
  event: z.infer<typeof eventSchema>,
  config: WebhookConfig,
  timestamp: number,
) {
  const age = timestamp - event.timestamp;
  return (
    event.recipient.id === config.INSTAGRAM_ACCOUNT_ID &&
    event.sender.id !== config.INSTAGRAM_ACCOUNT_ID &&
    !event.message.is_echo &&
    !event.message.is_self &&
    !event.message.is_deleted &&
    age >= 0 &&
    age < EVENT_WINDOW_MS &&
    event.message.attachments?.some(
      (attachment) => reelAttachmentSchema.safeParse(attachment).success,
    ) === true
  );
}
