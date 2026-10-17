import { describe, expect, it, vi } from "vitest";
import {
  measureProviderCall,
  recordExtractionResult,
  recordRequestEvent,
  trackMatcher,
  withTrackedRequest,
} from "../../src/features/tracking/requests";
import type {
  RequestReport,
  RequestStore,
} from "../../src/features/tracking/requests";
import { googlePlaceIdSchema } from "../../src/features/places/google";

const input = {
  id: "request-1",
  accountId: "100",
  messageId: "mid",
  senderId: "200",
};
const mention = {
  name: "Cafe",
  city: "Berlin",
  country: "Germany",
  evidence: "Cafe in Berlin",
};
const extracted = {
  kind: "extracted" as const,
  value: { mentions: [mention] },
};
function fixture() {
  const begin = vi.fn<RequestStore["begin"]>().mockResolvedValue(true);
  const complete = vi
    .fn<RequestStore["complete"]>()
    .mockResolvedValue(undefined);
  return { begin, complete };
}
const noReplies = () => ({ sent: 0, failed: 0 });

describe("request tracking", () => {
  it("skips all external effects for a durable duplicate", async () => {
    const store = fixture();
    store.begin.mockResolvedValue(false);
    const action = vi.fn();
    expect(
      await withTrackedRequest(store, input, false, noReplies, action),
    ).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("records only final mentions and permitted place fields", async () => {
    const store = fixture();
    await withTrackedRequest(store, input, false, noReplies, async () => {
      const match = trackMatcher(async () => ({
        kind: "matched",
        place: {
          id: googlePlaceIdSchema.parse("place-1"),
          name: "Provider name",
          address: "Provider address",
          confidence: "high",
          imageUrl: "https://example.com/private-photo",
          attributions: [],
          links: {
            googleMaps: "https://example.com/google",
            appleMaps: "https://example.com/apple",
          },
        },
      }));
      await match?.(mention);
      recordExtractionResult(extracted);
      recordRequestEvent({
        event: "places.match_completed",
        outcome: "matched",
        caption: "PRIVATE",
        apiKey: "SECRET",
      });
    });
    const report = store.complete.mock.calls[0][1];
    expect(report.status).toBe("completed");
    expect(report.places).toEqual([
      {
        ordinal: 0,
        google_place_id: "place-1",
        mention_name: "Cafe",
        city: "Berlin",
        country: "Germany",
        match_kind: "matched",
        confidence: "high",
        photo_available: true,
      },
    ]);
    const serialized = JSON.stringify(report);
    for (const privateValue of [
      "Provider name",
      "Provider address",
      "private-photo",
      "PRIVATE",
      "SECRET",
      "evidence",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it.each(["partial", "no_places", "failed", "unsupported"] as const)(
    "classifies %s independently of the progress reply",
    async (status) => {
      const store = fixture();
      await withTrackedRequest(
        store,
        input,
        status === "unsupported",
        noReplies,
        async () => {
          if (status === "partial") recordExtractionResult(extracted);
          if (status === "no_places")
            recordExtractionResult({ kind: "no-place" });
          if (status === "failed")
            recordExtractionResult({
              kind: "invalid-output",
              reason: "provider",
            });
        },
      );
      expect(store.complete.mock.calls[0][1].status).toBe(status);
    },
  );

  it("records provider failures without inventing token usage", async () => {
    const store = fixture();
    const failure = new Error("private provider error");
    await expect(
      withTrackedRequest(store, input, false, noReplies, async () => {
        await measureProviderCall("gemini", "caption", async () => {
          throw failure;
        });
      }),
    ).rejects.toThrow(failure);
    const report = store.complete.mock.calls[0][1];
    expect(report.status).toBe("failed");
    expect(report.usage).toHaveLength(1);
    expect(report.usage[0]).toMatchObject({
      provider: "gemini",
      operation: "caption",
      succeeded: false,
    });
    expect(report.usage[0].total_tokens).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain(failure.message);
  });

  it("isolates provider usage across concurrent requests", async () => {
    const reports = new Map<string, RequestReport>();
    const store: RequestStore = {
      begin: async () => true,
      complete: async (id, report) => {
        reports.set(id, report);
      },
    };
    await Promise.all(
      [1, 2].map((tokens) =>
        withTrackedRequest(
          store,
          { ...input, id: String(tokens) },
          false,
          noReplies,
          async () => {
            await measureProviderCall(
              "gemini",
              "caption",
              async () => {
                await Promise.resolve();
                return tokens;
              },
              (total) => ({ total_tokens: total, model: "test-model" }),
            );
            recordExtractionResult({ kind: "no-place" });
          },
        ),
      ),
    );
    expect(reports.get("1")?.usage.map((usage) => usage.total_tokens)).toEqual([
      1,
    ]);
    expect(reports.get("2")?.usage.map((usage) => usage.total_tokens)).toEqual([
      2,
    ]);
  });

  it("runs normally when persistence is not configured", async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    expect(
      await withTrackedRequest(undefined, input, false, noReplies, action),
    ).toBe(true);
    expect(action).toHaveBeenCalledOnce();
  });
});
