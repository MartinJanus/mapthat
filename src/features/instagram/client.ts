import ky, { NetworkError, TimeoutError, ResponseSizeError } from "ky";
import type { KyInstance } from "ky";
import { z } from "zod";
import { instagramIdSchema } from "./config";
import type { InstagramId, WebhookConfig } from "./config";

export const FIXED_REPLY =
  "Thanks! MapThat received your message. This is a connectivity test.";

export type SendResult =
  | { readonly kind: "sent" }
  | {
      readonly kind: "failed";
      readonly reason: "http" | "transport" | "response";
    };

const replySchema = z.object({
  recipient_id: instagramIdSchema,
  message_id: z.string().min(1),
});

export function createInstagramSender(
  config: WebhookConfig,
  http: KyInstance = ky,
) {
  return async (recipient: InstagramId): Promise<SendResult> => {
    try {
      const response = await http.post(
        `https://graph.instagram.com/${config.INSTAGRAM_API_VERSION}/${config.INSTAGRAM_ACCOUNT_ID}/messages`,
        {
          headers: { Authorization: `Bearer ${config.INSTAGRAM_ACCESS_TOKEN}` },
          json: {
            recipient: { id: recipient },
            message: { text: FIXED_REPLY },
          },
          timeout: 5000,
          retry: 0,
          redirect: "error",
          throwHttpErrors: false,
          maxResponseSize: 64 * 1024,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return { kind: "failed", reason: "http" };
      }
      const parsed = replySchema.safeParse(await response.json<unknown>());
      return parsed.success && parsed.data.recipient_id === recipient
        ? { kind: "sent" }
        : { kind: "failed", reason: "response" };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ResponseSizeError) {
        return { kind: "failed", reason: "response" };
      }
      if (
        error instanceof NetworkError ||
        error instanceof TimeoutError ||
        error instanceof TypeError
      ) {
        return { kind: "failed", reason: "transport" };
      }
      throw error;
    }
  };
}
