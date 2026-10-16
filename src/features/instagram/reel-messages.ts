import { z } from "zod";
import { instagramIdSchema } from "./config";
import type { InstagramId } from "./config";
import type { SendText, InstagramMessenger } from "./client";
import { preparePlaceCards, splitMessageText } from "./place-cards";
import type { MatchPlace } from "../places/google";
import type { envelopeSchema } from "./messages";
import { prepareCaptionPlaceResults } from "../places/caption";
import type { CaptionExtractionResult } from "../places/caption";
import { createCachedReelExtractor } from "./cached-reel-extractor";
import { resolveReel } from "./resolve-reel";
import type { ExtractVideo } from "../places/video";

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
    attachments: z
      .array(
        z.object({
          type: z.literal("ig_reel"),
          payload: z.object({
            title: z.string().trim().default(""),
            reel_video_id: z
              .string()
              .regex(/^\d+$/)
              .optional()
              .catch(undefined),
            url: z.string().optional().catch(undefined),
          }),
        }),
      )
      .min(1),
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

export function createReelMessageProcessor(
  options: Parameters<typeof createCachedReelExtractor>[0] & {
    readonly now?: () => number;
    readonly extract: (caption: string) => Promise<CaptionExtractionResult>;
    readonly match?: MatchPlace;
    readonly video?: ExtractVideo;
  },
) {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, number>();
  const extractReel = createCachedReelExtractor(options);

  return async (
    envelope: z.infer<typeof envelopeSchema>,
    account: InstagramId,
    messenger: SendText | InstagramMessenger,
  ): Promise<ReelMessageSummary> => {
    const sendText =
      typeof messenger === "function" ? messenger : messenger.sendText;
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
        const recipient = event.data.sender.id;

        if (typeof messenger !== "function") {
          await messenger.reactToMessage(
            event.data.sender.id,
            event.data.message.mid,
          );
        }

        const first = await sendText(
          event.data.sender.id,
          "Finding your locations…",
        );
        if (first.kind === "failed") {
          summary.failed++;
          continue;
        }
        summary.sent++;

        const reel = event.data.message.attachments[0].payload;
        const caption = reel.title
          ? await extractReel(reel)
          : { kind: "no-place" as const };
        const { result, match } = await resolveReel(
          reel,
          caption,
          options.match,
          options.video,
        );
        if (result.kind === "extracted" && typeof messenger !== "function") {
          const prepared = await preparePlaceCards(result.value, match);
          for (const text of prepared.texts) await sendReply(text);
          for (let offset = 0; offset < prepared.cards.length; offset += 10) {
            const cards = prepared.cards.slice(offset, offset + 10);
            let creditsSent = true;
            for (const card of cards) {
              for (const credit of card.attributions) {
                if (!(await sendReply(credit))) creditsSent = false;
              }
            }
            if (!creditsSent) {
              for (const card of cards) await sendReply(card.fallback);
              continue;
            }
            const sent = await messenger.sendGenericTemplate(
              event.data.sender.id,
              cards.map((card) => card.element),
            );
            switch (sent.kind) {
              case "sent":
                summary.sent++;
                break;
              case "failed":
                summary.failed++;
                for (const card of cards) await sendReply(card.fallback);
                break;
              default: {
                const exhaustive: never = sent;
                return exhaustive;
              }
            }
          }
          continue;
        }
        for (const text of formatExtractionReply(result)) {
          const sent = await sendText(event.data.sender.id, text);
          if (sent.kind === "sent") summary.sent++;
          else summary.failed++;
        }

        async function sendReply(text: string) {
          let success = true;
          for (const part of splitMessageText(text)) {
            const sent = await sendText(recipient, part);
            if (sent.kind === "sent") summary.sent++;
            else {
              summary.failed++;
              success = false;
            }
          }
          return success;
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
        result.reason === "provider" || result.reason === "configuration"
          ? "Place extraction is temporarily unavailable. Please try again later."
          : "I couldn't confidently read the places in this Reel. Send the place name and city, or try another Reel.",
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
