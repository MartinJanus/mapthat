import axios, { AxiosError } from "axios";
import type { AxiosInstance } from "axios";
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
          headers: { Authorization: `Bearer ${config.INSTAGRAM_ACCESS_TOKEN}` },
          adapter: "http",
          timeout: 5000,
          signal: AbortSignal.timeout(5000),
          maxRedirects: 0,
          validateStatus: () => true,
          maxContentLength: 64 * 1024,
          responseType: "text",
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
      if (error instanceof SyntaxError) {
        return { kind: "failed", reason: "response" };
      }
      if (axios.isAxiosError(error)) {
        return {
          kind: "failed",
          reason:
            error.code === AxiosError.ERR_BAD_RESPONSE
              ? "response"
              : "transport",
        };
      }
      throw error;
    }
  };
}
