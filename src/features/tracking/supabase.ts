import { createHmac } from "node:crypto";
import { z } from "zod";
import { reelExtractionKey } from "../instagram/reel-identity";
import { TrackingUnavailableError } from "./requests";
import type { RequestStore } from "./requests";

const configSchema = z.object({
  SUPABASE_URL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.endsWith(".supabase.co") &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  }),
  SUPABASE_SECRET_KEY: z.string().startsWith("sb_secret_").min(20),
  TRACKING_HASH_SECRET: z.string().min(32),
});

export function createSupabaseRequestStore(
  environment: unknown,
  http: typeof fetch = fetch,
): RequestStore | undefined {
  const raw =
    typeof environment === "object" && environment !== null
      ? (environment as Record<string, unknown>)
      : {};
  if (
    !["SUPABASE_URL", "SUPABASE_SECRET_KEY", "TRACKING_HASH_SECRET"].some(
      (key) => raw[key],
    )
  ) {
    return undefined;
  }
  const config = configSchema.safeParse(environment);
  const pseudonym = (scope: string, value: string) => {
    if (!config.success) throw new TrackingUnavailableError();
    return createHmac("sha256", config.data.TRACKING_HASH_SECRET)
      .update(JSON.stringify([scope, value]))
      .digest("hex");
  };
  async function request(path: string, body: unknown, prefer?: string) {
    if (!config.success) throw new TrackingUnavailableError();
    try {
      const response = await http(new URL(path, config.data.SUPABASE_URL), {
        method: "POST",
        headers: {
          apikey: config.data.SUPABASE_SECRET_KEY,
          "Content-Type": "application/json",
          ...(prefer ? { Prefer: prefer } : {}),
        },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new TrackingUnavailableError();
      return response;
    } catch {
      // Provider response bodies can include private data. Never log them.
      throw new TrackingUnavailableError();
    }
  }
  return {
    async begin(input) {
      const reelKey = input.reel
        ? reelExtractionKey({ ...input.reel, title: "" }, "identity-v1")
        : undefined;
      const response = await request(
        "/rest/v1/extraction_requests?on_conflict=account_ref,message_ref",
        {
          id: input.id,
          account_ref: pseudonym("account", input.accountId),
          message_ref: pseudonym(
            "message",
            JSON.stringify([input.accountId, input.messageId]),
          ),
          sender_ref: pseudonym(
            "sender",
            JSON.stringify([input.accountId, input.senderId]),
          ),
          reel_ref: reelKey ? pseudonym("reel", reelKey) : null,
        },
        "resolution=ignore-duplicates,return=representation",
      );
      try {
        const rows = z
          .array(z.object({ id: z.uuid() }))
          .max(1)
          .parse(await response.json());
        return rows.length === 1;
      } catch {
        throw new TrackingUnavailableError();
      }
    },
    async complete(id, report) {
      await request("/rest/v1/rpc/complete_extraction_request", {
        p_request_id: id,
        p_status: report.status,
        p_duration_ms: report.duration_ms,
        p_replies_sent: report.replies_sent,
        p_replies_failed: report.replies_failed,
        p_places: report.places,
        p_usage: report.usage,
        p_events: report.events,
      });
    },
  };
}
