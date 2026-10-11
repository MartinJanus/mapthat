import { z } from "zod";
import { instagramIdSchema } from "./config";
import type { InstagramId } from "./config";
import type { SendText } from "./client";
import type { envelopeSchema } from "./messages";
import { prepareCaptionPlaceResults } from "../places/caption";
import type { CaptionExtractionResult } from "../places/caption";

const entrySchema = z.object({
  id: instagramIdSchema,
  messaging: z.array(z.unknown()),
});
const reelMessageSchema = z.object({
  sender: z.object({ id: instagramIdSchema }),
  recipient: z.object({ id: instagramIdSchema }),
  timestamp: z.number().int().nonnegative(),
  message: z.object({
    mid: z.string().min(1),
    attachments: z.array(
      z.object({
        type: z.literal("ig_reel"),
        payload: z.object({ title: z.string().trim().min(1) }),
      }),
    ),
    is_echo: z.boolean().optional(),
    is_self: z.boolean().optional(),
    is_deleted: z.boolean().optional(),
  }),
});

const EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEDUPLICATION_RETENTION_MS = 36 * 60 * 60 * 1000;

export type ReelMessageSummary = {
  readonly sent: number;
  readonly failed: number;
  readonly ignored: number;
  readonly duplicate: number;
};

export function createReelMessageProcessor(options: {
  readonly now?: () => number;
  readonly extract: (caption: string) => Promise<CaptionExtractionResult>;
}) {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, number>();

  return async (
    envelope: z.infer<typeof envelopeSchema>,
    account: InstagramId,
    sendText: SendText,
  ): Promise<ReelMessageSummary> => {
    const summary = { sent: 0, failed: 0, ignored: 0, duplicate: 0 };
    removeExpiredAttempts(attempts, now());
    if (envelope.object !== "instagram") return { ...summary, ignored: 1 };

    for (const rawEntry of envelope.entry) {
      const entry = entrySchema.safeParse(rawEntry);
      if (!entry.success || entry.data.id !== account) {
        summary.ignored++;
        continue;
      }
      for (const rawMessage of entry.data.messaging) {
        const event = reelMessageSchema.safeParse(rawMessage);
        if (!event.success || !isIncomingReel(event.data, account, now())) {
          summary.ignored++;
          continue;
        }
        const key = `${account}:${event.data.message.mid}`;
        if (attempts.has(key)) {
          summary.duplicate++;
          continue;
        }
        attempts.set(key, now() + DEDUPLICATION_RETENTION_MS);

        const first = await sendText(
          event.data.sender.id,
          "Finding your locations…",
        );
        if (first.kind === "failed") {
          summary.failed++;
          continue;
        }
        summary.sent++;

        const result = await options.extract(
          event.data.message.attachments[0].payload.title,
        );
        for (const text of formatExtractionReply(result)) {
          const sent = await sendText(event.data.sender.id, text);
          if (sent.kind === "sent") summary.sent++;
          else summary.failed++;
        }
      }
    }
    return summary;
  };
}

function removeExpiredAttempts(
  attempts: Map<string, number>,
  timestamp: number,
) {
  for (const [message, expires] of attempts) {
    if (expires <= timestamp) attempts.delete(message);
  }
}

function isIncomingReel(
  event: z.infer<typeof reelMessageSchema>,
  account: InstagramId,
  timestamp: number,
) {
  const age = timestamp - event.timestamp;
  return (
    event.recipient.id === account &&
    event.sender.id !== account &&
    !event.message.is_echo &&
    !event.message.is_self &&
    !event.message.is_deleted &&
    age >= 0 &&
    age < EVENT_WINDOW_MS
  );
}

function formatExtractionReply(
  result: CaptionExtractionResult,
): readonly string[] {
  switch (result.kind) {
    case "no-place":
      return ["I couldn't find a place recommendation in that Reel's caption."];
    case "invalid-output":
      return [
        "I couldn't read the places in that Reel's caption. Please try another Reel.",
      ];
    case "extracted":
      return formatPlaceResults(prepareCaptionPlaceResults(result.value));
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function formatPlaceResults(
  places: ReturnType<typeof prepareCaptionPlaceResults>,
): readonly string[] {
  const replies: string[] = [];
  let number = 1;
  for (const place of places) {
    switch (place.kind) {
      case "candidate":
        replies.push(
          `${number}. ${place.mention.name}\nGoogle Maps: ${place.links.googleMaps}\nApple Maps: ${place.links.appleMaps}`,
        );
        number++;
        break;
      case "ambiguous":
        replies.push(
          `I found ${place.mention.name}, but the caption does not give enough location detail to identify the right place.`,
        );
        break;
      default: {
        const exhaustive: never = place;
        return exhaustive;
      }
    }
  }
  return replies.length > 0
    ? replies
    : ["I couldn't find a place recommendation in that Reel's caption."];
}
