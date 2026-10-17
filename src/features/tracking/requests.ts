import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { CaptionExtractionResult, PlaceMention } from "../places/caption";
import type { MatchPlace, PlaceMatchResult } from "../places/google";
import type { ReelCaption } from "../instagram/reel-identity";

export type RequestInput = {
  id: string;
  accountId: string;
  messageId: string;
  senderId: string;
  reel?: ReelCaption;
};
export type ProviderUsage = {
  id: string;
  provider: "gemini" | "google_places";
  operation: "caption" | "video" | "search" | "photo";
  succeeded: boolean;
  duration_ms: number;
  model?: string;
  http_status?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  thought_tokens?: number;
  total_tokens?: number;
};
type StoredPlace = {
  ordinal: number;
  google_place_id: string | null;
  mention_name: string;
  city: string | null;
  country: string | null;
  match_kind: PlaceMatchResult["kind"] | "unconfigured";
  confidence: "high" | "medium" | "possible" | null;
  photo_available: boolean;
};
export type RequestReport = {
  status: "completed" | "partial" | "no_places" | "failed" | "unsupported";
  duration_ms: number;
  replies_sent: number;
  replies_failed: number;
  places: StoredPlace[];
  usage: ProviderUsage[];
  events: {
    ordinal: number;
    event: string;
    fields: Record<string, string | number>;
  }[];
};
export type RequestStore = {
  begin(input: RequestInput): Promise<boolean>;
  complete(id: string, report: RequestReport): Promise<void>;
};
export class TrackingUnavailableError extends Error {
  constructor() {
    super("Request persistence unavailable");
  }
}
type State = {
  result?: CaptionExtractionResult;
  matches: Map<string, PlaceMatchResult>;
  usage: ProviderUsage[];
  events: RequestReport["events"];
};
const context = new AsyncLocalStorage<State>();

export async function withTrackedRequest(
  store: RequestStore | undefined,
  input: RequestInput,
  unsupported: boolean,
  replies: () => { sent: number; failed: number },
  action: () => Promise<void>,
): Promise<boolean> {
  if (!store) {
    await action();
    return true;
  }
  if (!(await store.begin(input))) return false;
  const state: State = { matches: new Map(), usage: [], events: [] };
  const started = Date.now();
  const before = replies();
  let crashed = false;
  try {
    await context.run(state, action);
  } catch (error) {
    crashed = true;
    throw error;
  } finally {
    const after = replies();
    const sent = after.sent - before.sent;
    const failed = after.failed - before.failed;
    const places =
      state.result?.kind === "extracted"
        ? state.result.value.mentions.map((mention, ordinal): StoredPlace => {
            const match = state.matches.get(JSON.stringify(mention));
            const place =
              match?.kind === "matched" || match?.kind === "no-photo"
                ? match.place
                : undefined;
            return {
              ordinal,
              google_place_id: place?.id ?? null,
              mention_name: mention.name,
              city: mention.city,
              country: mention.country,
              match_kind: match?.kind ?? "unconfigured",
              confidence: place?.confidence ?? null,
              photo_available: Boolean(place?.imageUrl),
            };
          })
        : [];
    const status: RequestReport["status"] =
      crashed || (!sent && failed)
        ? "failed"
        : unsupported
          ? failed
            ? "failed"
            : "unsupported"
          : !state.result || state.result.kind === "invalid-output"
            ? "failed"
            : failed
              ? places.length
                ? "partial"
                : "failed"
              : !places.length
                ? "no_places"
                : places.some((place) => place.confidence !== "high")
                  ? "partial"
                  : "completed";
    await store.complete(input.id, {
      status,
      duration_ms: Date.now() - started,
      replies_sent: sent,
      replies_failed: failed,
      places,
      usage: state.usage,
      events: state.events,
    });
  }
  return true;
}

export function recordExtractionResult(result: CaptionExtractionResult) {
  const state = context.getStore();
  if (state) state.result = result;
}
export function trackMatcher(
  match: MatchPlace | undefined,
): MatchPlace | undefined {
  if (!match) return undefined;
  return async (mention: PlaceMention) => {
    const result = await match(mention);
    context.getStore()?.matches.set(JSON.stringify(mention), result);
    return result;
  };
}

export async function measureProviderCall<T>(
  provider: ProviderUsage["provider"],
  operation: ProviderUsage["operation"],
  action: () => Promise<T>,
  details: (result: T) => Partial<ProviderUsage> = () => ({}),
): Promise<T> {
  const started = Date.now();
  const state = context.getStore();
  try {
    const result = await action();
    const metadata = details(result);
    state?.usage.push({
      ...metadata,
      id: randomUUID(),
      provider,
      operation,
      succeeded: metadata.succeeded ?? true,
      duration_ms: Date.now() - started,
    });
    return result;
  } catch (error) {
    state?.usage.push({
      id: randomUUID(),
      provider,
      operation,
      succeeded: false,
      duration_ms: Date.now() - started,
    });
    throw error;
  }
}

// Allowlisted diagnostics only; never persist arbitrary log fields.
export function recordRequestEvent(
  record: Readonly<Record<string, string | number>>,
) {
  const state = context.getStore();
  if (!state || state.events.length >= 200 || typeof record.event !== "string")
    return;
  const allowed = new Set([
    "stage",
    "outcome",
    "reason",
    "durationMs",
    "confidence",
    "cardCount",
    "photoCount",
    "mentionCount",
    "status",
    "candidateCount",
    "cityMatchCount",
    "countryMatchCount",
    "geographyCount",
    "placeRef",
    "topScore",
    "runnerUpScore",
    "scoreGap",
    "photoIndex",
  ]);
  const fields = Object.fromEntries(
    Object.entries(record).filter(([key]) => allowed.has(key)),
  );
  state.events.push({
    ordinal: state.events.length,
    event: record.event,
    fields,
  });
}
