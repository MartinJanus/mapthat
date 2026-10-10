import { z } from "zod";
import { instagramIdSchema } from "./config";
import type { InstagramId } from "./config";
import type { SendResult } from "./client";

export const envelopeSchema = z
  .object({
    object: z.string(),
    entry: z.array(z.unknown()).readonly(),
  })
  .readonly();

const entrySchema = z.object({
  id: instagramIdSchema,
  messaging: z.array(z.unknown()).default([]).readonly(),
});
const messageSchema = z.object({
  sender: z.object({ id: instagramIdSchema }),
  recipient: z.object({ id: instagramIdSchema }),
  timestamp: z.number().int().nonnegative(),
  message: z.object({
    mid: z.string().min(1).brand<"MessageId">(),
    text: z.string().min(1),
    is_echo: z.boolean().optional(),
    is_self: z.boolean().optional(),
    is_deleted: z.boolean().optional(),
    is_unsupported: z.boolean().optional(),
    attachments: z.unknown().optional(),
  }),
});

const WINDOW_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 36 * 60 * 60 * 1000;

export type BatchSummary = {
  readonly sent: number;
  readonly failed: number;
  readonly ignored: number;
  readonly duplicate: number;
  readonly capacity: number;
};

export function createMessageProcessor(
  options: {
    readonly now?: () => number;
    readonly maxEntries?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 10000;
  // Reservations are mutable, process-local, and retained even after uncertain sends.
  const attempts = new Map<string, number>();

  return async (
    envelope: z.infer<typeof envelopeSchema>,
    account: InstagramId,
    send: (recipient: InstagramId) => Promise<SendResult>,
  ): Promise<BatchSummary> => {
    const summary = {
      sent: 0,
      failed: 0,
      ignored: 0,
      duplicate: 0,
      capacity: 0,
    };
    for (const [key, expires] of attempts) {
      if (expires <= now()) attempts.delete(key);
    }
    if (envelope.object !== "instagram") {
      summary.ignored++;
      return summary;
    }
    for (const rawEntry of envelope.entry) {
      const entry = entrySchema.safeParse(rawEntry);
      if (!entry.success || entry.data.id !== account) {
        summary.ignored++;
        continue;
      }
      for (const rawMessage of entry.data.messaging) {
        const parsed = messageSchema.safeParse(rawMessage);
        if (!parsed.success) {
          summary.ignored++;
          continue;
        }
        const event = parsed.data;
        const age = now() - event.timestamp;
        if (
          event.recipient.id !== account ||
          event.sender.id === account ||
          event.message.is_echo ||
          event.message.is_self ||
          event.message.is_deleted ||
          event.message.is_unsupported ||
          event.message.attachments !== undefined ||
          age < 0 ||
          age >= WINDOW_MS
        ) {
          summary.ignored++;
          continue;
        }
        const key = `${account}:${event.message.mid}`;
        if (attempts.has(key)) {
          summary.duplicate++;
          continue;
        }
        if (attempts.size >= maxEntries) {
          summary.capacity++;
          continue;
        }
        attempts.set(key, now() + RETENTION_MS);
        const result = await send(event.sender.id);
        switch (result.kind) {
          case "sent":
            summary.sent++;
            break;
          case "failed":
            summary.failed++;
            break;
          default: {
            const exhaustive: never = result;
            return exhaustive;
          }
        }
      }
    }
    return summary;
  };
}
