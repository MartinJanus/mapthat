import { z } from "zod";

export const geminiConfigSchema = z
  .object({
    GEMINI_API_KEY: z.string().trim().min(1),
    GEMINI_MODEL: z.string().trim().min(1).default("gemini-3.5-flash-lite"),
  })
  .readonly();

export type GeminiConfig = z.infer<typeof geminiConfigSchema>;
