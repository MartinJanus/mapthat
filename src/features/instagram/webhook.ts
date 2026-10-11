import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyConfigSchema, webhookConfigSchema } from "./config";
import { createInstagramSender } from "./client";
import { createMessageProcessor, envelopeSchema } from "./messages";
import { createReelCapture } from "./reel-capture";

const MAX_BODY_BYTES = 1024 * 1024;
const responseHeaders = { "Cache-Control": "no-store" } as const;

type WebhookBody =
  | { readonly kind: "body"; readonly value: Buffer }
  | { readonly kind: "missing" }
  | { readonly kind: "too-large" }
  | { readonly kind: "unreadable" };

export function createWebhookHandlers(options: {
  readonly environment: () => unknown;
  readonly processMessages?: ReturnType<typeof createMessageProcessor>;
  readonly sender?: typeof createInstagramSender;
  readonly captureReel?: ReturnType<typeof createReelCapture>;
  readonly log?: (record: Readonly<Record<string, string | number>>) => void;
}) {
  const processMessages = options.processMessages ?? createMessageProcessor();
  const sender = options.sender ?? createInstagramSender;
  const captureReel = options.captureReel ?? createReelCapture();
  const log = options.log ?? ((record) => console.info(JSON.stringify(record)));
  const reply = (body: string, status: number) =>
    new Response(body, {
      status,
      headers: responseHeaders,
    });

  return {
    GET(request: Request) {
      const config = verifyConfigSchema.safeParse(options.environment());
      if (!config.success) return reply("Webhook not configured", 503);
      const params = new URL(request.url).searchParams;
      const token = params.get("hub.verify_token");
      const challenge = params.get("hub.challenge");
      if (params.get("hub.mode") !== "subscribe" || !token || !challenge) {
        return reply("Invalid verification request", 400);
      }
      const expected = Buffer.from(config.data.INSTAGRAM_VERIFY_TOKEN);
      const received = Buffer.from(token);
      if (
        expected.length !== received.length ||
        !timingSafeEqual(expected, received)
      ) {
        return reply("Forbidden", 403);
      }
      return reply(challenge, 200);
    },

    async POST(request: Request) {
      const config = webhookConfigSchema.safeParse(options.environment());
      if (!config.success) {
        log({ event: "instagram.config_missing", level: "error" });
        return reply("Webhook not configured", 503);
      }
      const signature = request.headers.get("x-hub-signature-256");
      if (!signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) {
        return reply("Forbidden", 403);
      }
      const rawBody = await readWebhookBody(request);
      if (rawBody.kind === "missing") return reply("Missing body", 400);
      if (rawBody.kind === "too-large") return reply("Body too large", 413);
      if (rawBody.kind === "unreadable") return reply("Unreadable body", 400);
      const body = rawBody.value;
      const expected = createHmac("sha256", config.data.INSTAGRAM_APP_SECRET)
        .update(body)
        .digest();
      const received = Buffer.from(signature.slice(7), "hex");
      if (!timingSafeEqual(expected, received)) return reply("Forbidden", 403);

      let input: unknown;
      try {
        input = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(body),
        );
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError)
          return reply("Invalid JSON", 400);
        throw error;
      }
      const envelope = envelopeSchema.safeParse(input);
      if (!envelope.success) return reply("Invalid event envelope", 400);
      try {
        await captureReel(envelope.data, config.data);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        log({ event: "instagram.reel_capture_failed", level: "error" });
      }
      const summary = await processMessages(
        envelope.data,
        config.data.INSTAGRAM_ACCOUNT_ID,
        sender(config.data),
      );
      log({
        event: "instagram.batch_processed",
        level: summary.failed ? "error" : "info",
        ...summary,
      });
      return reply("EVENT_RECEIVED", summary.capacity ? 503 : 200);
    },
  };
}

async function readWebhookBody(request: Request): Promise<WebhookBody> {
  const reader = request.body?.getReader();
  if (!reader) return { kind: "missing" };

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return { kind: "body", value: Buffer.concat(chunks) };
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return { kind: "too-large" };
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof Error) return { kind: "unreadable" };
    throw error;
  } finally {
    reader.releaseLock();
  }
}
