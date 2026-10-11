import axios from "axios";
import type { AxiosInstance } from "axios";
import { z } from "zod";
import { instagramIdSchema } from "./config";
import type { InstagramId, WebhookConfig } from "./config";
import {
  classifyInstagramRequestFailure,
  createInstagramRequestOptions,
} from "./http";

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

const MAX_TEXT_BYTES = 1000;

export type SendText = (
  recipient: InstagramId,
  text: string,
) => Promise<SendResult>;

export function createInstagramSender(
  config: WebhookConfig,
  http: AxiosInstance = axios,
) {
  const sendText = createInstagramTextSender(config, http);
  return async (recipient: InstagramId): Promise<SendResult> =>
    sendText(recipient, FIXED_REPLY);
}

export function createInstagramTextSender(
  config: WebhookConfig,
  http: AxiosInstance = axios,
): SendText {
  return async (recipient, text): Promise<SendResult> => {
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      return { kind: "failed", reason: "response" };
    }
    try {
      const response = await http.post<unknown>(
        `https://graph.instagram.com/${config.INSTAGRAM_API_VERSION}/${config.INSTAGRAM_ACCOUNT_ID}/messages`,
        {
          recipient: { id: recipient },
          message: { text },
        },
        {
          ...createInstagramRequestOptions(config.INSTAGRAM_ACCESS_TOKEN),
        },
      );
      if (response.status < 200 || response.status >= 300) {
        return { kind: "failed", reason: "http" };
      }
      if (typeof response.data !== "string") {
        return { kind: "failed", reason: "response" };
      }
      const body: unknown = JSON.parse(response.data);
      const parsed = replySchema.safeParse(body);
      return parsed.success && parsed.data.recipient_id === recipient
        ? { kind: "sent" }
        : { kind: "failed", reason: "response" };
    } catch (error) {
      const reason = classifyInstagramRequestFailure(error);
      if (reason) return { kind: "failed", reason };
      throw error;
    }
  };
}
