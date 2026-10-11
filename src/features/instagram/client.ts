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

export function createInstagramSender(
  config: WebhookConfig,
  http: AxiosInstance = axios,
) {
  return async (recipient: InstagramId): Promise<SendResult> => {
    try {
      const response = await http.post<unknown>(
        `https://graph.instagram.com/${config.INSTAGRAM_API_VERSION}/${config.INSTAGRAM_ACCOUNT_ID}/messages`,
        {
          recipient: { id: recipient },
          message: { text: FIXED_REPLY },
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
