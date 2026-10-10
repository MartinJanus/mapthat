import { z } from "zod";

export const instagramIdSchema = z
  .string()
  .regex(/^\d+$/)
  .brand<"InstagramId">();
export type InstagramId = z.infer<typeof instagramIdSchema>;

export const verifyConfigSchema = z
  .object({
    INSTAGRAM_VERIFY_TOKEN: z.string().trim().min(1),
  })
  .readonly();

export const webhookConfigSchema = z
  .object({
    INSTAGRAM_APP_SECRET: z.string().trim().min(1),
    INSTAGRAM_ACCESS_TOKEN: z.string().trim().min(1),
    INSTAGRAM_ACCOUNT_ID: instagramIdSchema,
    INSTAGRAM_API_VERSION: z
      .string()
      .regex(/^v\d+\.0$/)
      .default("v25.0"),
  })
  .readonly();

export type WebhookConfig = z.infer<typeof webhookConfigSchema>;
