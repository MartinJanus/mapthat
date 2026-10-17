import { describe, expect, it, vi } from "vitest";
import { createSupabaseRequestStore } from "../../src/features/tracking/supabase";
import { TrackingUnavailableError } from "../../src/features/tracking/requests";

const environment = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_test-placeholder",
  TRACKING_HASH_SECRET: "test-only-stable-pseudonym-key-12345",
};
const input = {
  id: "00000000-0000-4000-8000-000000000001",
  accountId: "10001",
  messageId: "private-message-id",
  senderId: "20002",
  reel: { title: "PRIVATE CAPTION", reel_video_id: "30003" },
};

describe("Supabase backend adapter", () => {
  it("disables persistence only when all settings are absent", () => {
    expect(createSupabaseRequestStore({})).toBeUndefined();
  });

  it("claims atomically and sends only keyed pseudonyms", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json([{ id: input.id }]));
    const store = createSupabaseRequestStore(environment, http)!;
    expect(await store.begin(input)).toBe(true);
    const [url, options] = http.mock.calls[0];
    expect(String(url)).toBe(
      "https://test.supabase.co/rest/v1/extraction_requests?on_conflict=account_ref,message_ref",
    );
    const headers = options?.headers as Record<string, string>;
    expect(headers.Prefer).toBe(
      "resolution=ignore-duplicates,return=representation",
    );
    expect(headers.apikey).toBe(environment.SUPABASE_SECRET_KEY);
    const body = JSON.parse(String(options?.body));
    for (const key of [
      "account_ref",
      "message_ref",
      "sender_ref",
      "reel_ref",
    ]) {
      expect(body[key]).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(body.account_ref).not.toBe(body.sender_ref);
    for (const value of [
      "10001",
      "20002",
      "30003",
      "private-message-id",
      "PRIVATE CAPTION",
    ]) {
      expect(String(options?.body)).not.toContain(value);
    }
    expect(options?.redirect).toBe("error");
    expect(options?.cache).toBe("no-store");
  });

  it("recognizes a duplicate across process instances", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
    expect(
      await createSupabaseRequestStore(environment, http)!.begin(input),
    ).toBe(false);
  });

  it.each([
    { ...environment, SUPABASE_SECRET_KEY: "" },
    { ...environment, TRACKING_HASH_SECRET: "short" },
    { ...environment, SUPABASE_URL: "http://test.supabase.co" },
  ])("fails closed for incomplete or invalid configuration", async (config) => {
    const http = vi.fn<typeof fetch>();
    await expect(
      createSupabaseRequestStore(config, http)!.begin(input),
    ).rejects.toBeInstanceOf(TrackingUnavailableError);
    expect(http).not.toHaveBeenCalled();
  });

  it("does not expose provider response bodies on failure", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("PRIVATE ERROR", { status: 503 }));
    await expect(
      createSupabaseRequestStore(environment, http)!.begin(input),
    ).rejects.toThrow("Request persistence unavailable");
  });

  it("finishes through one transactional RPC", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await createSupabaseRequestStore(environment, http)!.complete(input.id, {
      status: "no_places",
      duration_ms: 12,
      replies_sent: 2,
      replies_failed: 0,
      places: [],
      usage: [],
      events: [],
    });
    expect(String(http.mock.calls[0][0])).toBe(
      "https://test.supabase.co/rest/v1/rpc/complete_extraction_request",
    );
    expect(JSON.parse(String(http.mock.calls[0][1]?.body))).toMatchObject({
      p_request_id: input.id,
      p_status: "no_places",
      p_places: [],
      p_usage: [],
      p_events: [],
    });
  });
});
