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

const httpsUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
});
export const genericElementSchema = z
  .object({
    title: z.string().min(1).max(80),
    subtitle: z.string().min(1).max(80).optional(),
    image_url: httpsUrlSchema.optional(),
    default_action: z
      .object({ type: z.literal("web_url"), url: httpsUrlSchema })
      .readonly()
      .optional(),
    buttons: z
      .array(
        z
          .object({
            type: z.literal("web_url"),
            title: z.string().min(1).max(20),
            url: httpsUrlSchema,
          })
          .readonly(),
      )
      .min(1)
      .max(3)
      .readonly(),
  })
  .readonly();
export type GenericElement = z.infer<typeof genericElementSchema>;
const elementsSchema = z.array(genericElementSchema).min(1).max(10);

export type InstagramMessenger = {
  readonly sendText: SendText;
  readonly reactToMessage: (
    recipient: InstagramId,
    messageId: string,
  ) => Promise<SendResult>;
  readonly sendGenericTemplate: (
    recipient: InstagramId,
    elements: readonly GenericElement[],
  ) => Promise<SendResult>;
};

export function createInstagramMessenger(
  config: WebhookConfig,
  http: AxiosInstance = axios,
): InstagramMessenger {
  return {
    sendText: createInstagramTextSender(config, http),
    reactToMessage: (recipient, messageId) =>
      reactToMessage(config, recipient, messageId, "👀", http),
    sendGenericTemplate: (recipient, elements) =>
      sendGenericTemplate(config, recipient, elements, http),
  };
}

export async function reactToMessage(
  config: WebhookConfig,
  recipient: InstagramId,
  messageId: string,
  reaction = "👀",
  http: AxiosInstance = axios,
): Promise<SendResult> {
  if (!messageId.trim() || !reaction.trim())
    return { kind: "failed", reason: "response" };
  return postMessage(
    config,
    recipient,
    {
      recipient: { id: recipient },
      sender_action: "react",
      payload: { message_id: messageId, reaction },
    },
    http,
    true,
  );
}

export async function sendGenericTemplate(
  config: WebhookConfig,
  recipient: InstagramId,
  elements: readonly GenericElement[],
  http: AxiosInstance = axios,
): Promise<SendResult> {
  const parsed = elementsSchema.safeParse(elements);
  if (!parsed.success) return { kind: "failed", reason: "response" };
  return postMessage(
    config,
    recipient,
    {
      recipient: { id: recipient },
      message: {
        attachment: {
          type: "template",
          payload: { template_type: "generic", elements: parsed.data },
        },
      },
    },
    http,
  );
}

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
    return postMessage(
      config,
      recipient,
      {
        recipient: { id: recipient },
        message: { text },
      },
      http,
    );
  };
}

async function postMessage(
  config: WebhookConfig,
  recipient: InstagramId,
  payload: Readonly<Record<string, unknown>>,
  http: AxiosInstance,
  reaction = false,
): Promise<SendResult> {
  try {
    const response = await http.post<unknown>(
      `https://graph.instagram.com/${config.INSTAGRAM_API_VERSION}/${config.INSTAGRAM_ACCOUNT_ID}/messages`,
      payload,
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
    if (
      reaction &&
      z.object({ success: z.literal(true) }).safeParse(body).success
    )
      return { kind: "sent" };
    const parsed = replySchema.safeParse(body);
    return parsed.success && parsed.data.recipient_id === recipient
      ? { kind: "sent" }
      : { kind: "failed", reason: "response" };
  } catch (error) {
    const reason = classifyInstagramRequestFailure(error);
    if (reason) return { kind: "failed", reason };
    throw error;
  }
}
