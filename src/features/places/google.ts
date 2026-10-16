import ky, { NetworkError, TimeoutError, ResponseSizeError } from "ky";
import { z } from "zod";
import {
  createDiagnosticLogger,
  placeReference,
  withDiagnosticContext,
} from "../observability/diagnostics";
import type { DiagnosticRecord } from "../observability/diagnostics";
import type { PlaceMention } from "./caption";
import {
  publicUrlSchema,
  searchSchema,
  placeSchema,
  photoSchema,
} from "./google-model";
import type {
  GooglePlacesConfig,
  GooglePlace,
  MatchPlace,
  PlaceMatchResult,
} from "./google-model";
export { googlePlacesConfigSchema, googlePlaceIdSchema } from "./google-model";
export type {
  GooglePlacesConfig,
  MatchedPlace,
  MatchPlace,
  PlaceMatchResult,
} from "./google-model";

export function createGooglePlacesMatcher(
  config: GooglePlacesConfig,
  http: typeof ky = ky,
  options: {
    readonly log?: (record: Readonly<Record<string, string | number>>) => void;
  } = {},
): MatchPlace {
  const log = createDiagnosticLogger(
    options.log ?? ((record) => console.warn(JSON.stringify(record))),
  );
  const diagnostic = (stage: string, reason: string, status = 0) =>
    log({ event: "places.request_failed", stage, reason, status });
  const client = http.extend({
    headers: { "X-Goog-Api-Key": config.GOOGLE_PLACES_API_KEY },
    timeout: 5000,
    retry: 0,
    redirect: "error",
    throwHttpErrors: false,
    maxResponseSize: 256 * 1024,
  });
  const matchPlace: MatchPlace = async (mention) => {
    if (!mention.city && !mention.country) {
      log({
        event: "places.match_decision",
        outcome: "ambiguous",
        reason: "missing_geography",
        possibleEnabled: 1,
      });
      return { kind: "ambiguous" };
    }
    try {
      const response = await client.post(
        "https://places.googleapis.com/v1/places:searchText",
        {
          headers: {
            "X-Goog-FieldMask":
              "places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents,places.photos,places.attributions",
          },
          json: {
            textQuery: [
              searchName(mention),
              mention.addressHint,
              mention.city,
              mention.country,
            ]
              .filter(Boolean)
              .join(", "),
            pageSize: 20,
            languageCode: "en",
          },
        },
      );
      if (!response.ok) {
        diagnostic("search", "http", response.status);
        return { kind: "unavailable" };
      }
      const parsed = searchSchema.safeParse(await response.json<unknown>());
      if (!parsed.success) {
        diagnostic("search", "response_schema");
        return { kind: "unavailable" };
      }
      const places: GooglePlace[] = [];
      for (const raw of parsed.data.places) {
        const place = placeSchema.safeParse(raw);
        if (place.success) places.push(place.data);
        else {
          log({
            event: "places.candidate_invalid",
            fields: place.error.issues
              .map((issue) => issue.path.join("."))
              .slice(0, 5)
              .join(","),
          });
        }
      }
      log({
        event: "places.search_result",
        candidateCount: parsed.data.places.length,
        validCount: places.length,
        invalidCount: parsed.data.places.length - places.length,
      });
      if (parsed.data.places.length > 0 && places.length === 0) {
        diagnostic("search", "response_schema");
        return { kind: "unavailable" };
      }
      const result = selectPlaceMatch(mention, places, {
        allowPossible: true,
        onDecision: (record) =>
          log({ event: "places.match_decision", ...record }),
      });
      if (result.kind !== "matched") return result;
      const selected = places.find((place) => place.id === result.place.id);
      // Invalid optional photo metadata must not discard a valid place.
      let photoIndex = 0;
      for (const rawPhoto of selected?.photos.slice(0, 3) ?? []) {
        photoIndex++;
        log({ event: "places.photo_attempt", photoIndex });
        const photo = photoSchema.safeParse(rawPhoto);
        if (!photo.success) {
          diagnostic("photo", "metadata_schema");
          continue;
        }
        const imageUrl = await loadPhoto(photo.data.name);
        if (imageUrl) {
          log({
            event: "places.photo_result",
            outcome: "available",
            photoIndex,
            sourceLink: photo.data.googleMapsUri ? 1 : 0,
            authorCount: photo.data.authorAttributions.length,
          });
          return {
            kind: "matched",
            place: {
              ...result.place,
              imageUrl,
              photoSourceUrl: photo.data.googleMapsUri,
              photoCredit: photo.data.authorAttributions[0],
              photoCredits: photo.data.authorAttributions,
            },
          };
        }
      }
      log({
        event: "places.photo_result",
        outcome: "omitted",
        reason: selected?.photos.length
          ? "all_photos_failed"
          : "no_photo_metadata",
        attempted: photoIndex,
      });
      return { kind: "no-photo", place: result.place };
    } catch (error) {
      if (
        error instanceof NetworkError ||
        error instanceof TimeoutError ||
        error instanceof ResponseSizeError ||
        error instanceof SyntaxError
      ) {
        diagnostic(
          "search",
          error instanceof TimeoutError ? "timeout" : "transport_or_json",
        );
        return { kind: "unavailable" };
      }
      throw error;
    }
  };

  return (mention) =>
    withDiagnosticContext({ placeRef: placeReference(mention) }, async () => {
      const started = Date.now();
      const result = await matchPlace(mention);
      log({
        event: "places.match_completed",
        outcome: result.kind,
        confidence:
          result.kind === "matched" || result.kind === "no-photo"
            ? result.place.confidence
            : "none",
        durationMs: Date.now() - started,
      });
      return result;
    });

  async function loadPhoto(name: string): Promise<string | undefined> {
    try {
      const response = await client.get(
        `https://places.googleapis.com/v1/${name}/media`,
        { searchParams: { maxWidthPx: 800, skipHttpRedirect: true } },
      );
      if (!response.ok) {
        diagnostic("photo", "http", response.status);
        return undefined;
      }
      const parsed = z
        .object({ photoUri: publicUrlSchema })
        .safeParse(await response.json<unknown>());
      if (!parsed.success) diagnostic("photo", "response_schema");
      return parsed.success ? parsed.data.photoUri : undefined;
    } catch (error) {
      if (
        error instanceof NetworkError ||
        error instanceof TimeoutError ||
        error instanceof ResponseSizeError ||
        error instanceof SyntaxError
      ) {
        diagnostic(
          "photo",
          error instanceof TimeoutError ? "timeout" : "transport_or_json",
        );
        return undefined;
      }
      throw error;
    }
  }
}

export function selectPlaceMatch(
  mention: PlaceMention,
  places: readonly GooglePlace[],
  options: {
    readonly allowPossible?: boolean;
    readonly onDecision?: (record: DiagnosticRecord) => void;
  } = {},
): PlaceMatchResult {
  const unique = [
    ...new Map(places.map((place) => [place.id, place])).values(),
  ];
  const geographic = unique.filter((place) => geographicMatch(mention, place));
  const addressed = geographic.filter(
    (place) =>
      !mention.addressHint ||
      normalize(place.formattedAddress).includes(
        normalize(mention.addressHint),
      ),
  );
  const ranked = addressed
    .map((place) => ({
      place,
      score: nameScore(searchName(mention), place.displayName.text),
    }))
    .sort((a, b) => b.score - a.score);
  const first = ranked[0];
  const second = ranked[1];
  const report = (
    result: PlaceMatchResult,
    reason: string,
  ): PlaceMatchResult => {
    options.onDecision?.({
      outcome: result.kind,
      reason,
      candidateCount: places.length,
      uniqueCount: unique.length,
      geographyCount: geographic.length,
      addressCount: addressed.length,
      topScore: Number((first?.score ?? 0).toFixed(3)),
      runnerUpScore: Number((second?.score ?? 0).toFixed(3)),
      scoreGap: Number(((first?.score ?? 0) - (second?.score ?? 0)).toFixed(3)),
      nameThreshold: 0.8,
      requiredGap: 0.2,
      possibleEnabled: options.allowPossible ? 1 : 0,
      cityPresent: mention.city ? 1 : 0,
      countryPresent: mention.country ? 1 : 0,
      addressHintPresent: mention.addressHint ? 1 : 0,
    });
    return result;
  };
  if (!places.length) return report({ kind: "not-found" }, "no_candidates");
  if (!mention.city && !mention.country)
    return report({ kind: "ambiguous" }, "missing_geography");
  if (!geographic.length)
    return report({ kind: "ambiguous" }, "geography_conflict");
  if (!addressed.length)
    return report({ kind: "ambiguous" }, "address_conflict");
  if (!first || first.score < 0.8)
    return report({ kind: "ambiguous" }, "weak_name");
  const uncertain = Boolean(second && first.score - second.score < 0.2);
  if (uncertain && !options.allowPossible)
    return report({ kind: "ambiguous" }, "competing_candidates");
  const query = `${first.place.location.latitude},${first.place.location.longitude}`;
  return report(
    {
      kind: "matched",
      place: {
        id: first.place.id,
        name: first.place.displayName.text,
        address: first.place.formattedAddress,
        confidence: uncertain
          ? "possible"
          : normalize(mention.name) === normalize(first.place.displayName.text)
            ? "high"
            : "medium",
        links: {
          googleMaps: `https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=${encodeURIComponent(first.place.id)}`,
          appleMaps: `https://maps.apple.com/?q=${query}&ll=${query}`,
        },
        attributions: first.place.attributions,
      },
    },
    uncertain ? "competing_candidates" : "accepted_unique",
  );
}

function normalize(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function nameScore(expected: string, actual: string) {
  const left = normalize(expected);
  const right = normalize(actual);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = new Set(left.split(" "));
  const b = new Set(right.split(" "));
  const intersection = [...a].filter((token) => b.has(token)).length;
  const overlap = intersection / new Set([...a, ...b]).size;
  // Reordered identical words can denote a different business.
  if (overlap === 1) return 0;

  // Descriptors and bilingual labels may differ; preserve distinctive name tokens.
  const descriptors = new Set([
    "the",
    "restaurant",
    "restaurants",
    "noodle",
    "noodles",
    "claypot",
    "rice",
    "shop",
    "bbq",
    "barbecue",
    "cafe",
    "café",
  ]);
  const core = (value: string) =>
    normalize(value)
      .split(" ")
      .filter(
        (token) => !descriptors.has(token) && !/\p{Script=Han}/u.test(token),
      );
  const aa = core(expected);
  const bb = core(actual);
  const sameCore =
    aa.length >= 2 && bb.length >= 2 && aa.join(" ") === bb.join(" ");
  const compactMatch = aa.join("") === bb.join("") && bb.join("").length >= 6;
  return Math.max(overlap, sameCore ? 0.92 : 0, compactMatch ? 0.92 : 0);
}

function geographicMatch(mention: PlaceMention, place: GooglePlace) {
  return ([mention.city, mention.country] as const).every(
    (value, index) =>
      !value ||
      place.addressComponents.some(
        (component) =>
          component.types.some((type) =>
            index === 1
              ? type === "country"
              : [
                  "locality",
                  "postal_town",
                  "administrative_area_level_1",
                  "sublocality",
                  // Hong Kong can be represented by a country component.
                  ...(geography(value) === "hong kong" ? ["country"] : []),
                ].includes(type),
          ) &&
          [component.longText, component.shortText].some(
            (text) =>
              text &&
              (geography(text) === geography(value) ||
                (index === 1 &&
                  geography(mention.city ?? "") === "hong kong" &&
                  normalize(value) === "china" &&
                  geography(text) === "hong kong")),
          ),
      ),
  );
}

function geography(value: string) {
  const normalized = normalize(value);
  return ["hk", "hong kong sar", "hong kong sar china"].includes(normalized)
    ? "hong kong"
    : normalized;
}

function searchName(mention: PlaceMention) {
  const name = mention.name.replace(/^@/, "");
  if (/\s/.test(name)) return name;
  const suffixes = [
    normalize(mention.city ?? "").replace(/\s/g, ""),
    normalize(mention.country ?? "").replace(/\s/g, ""),
    ...(geography(mention.city ?? "") === "hong kong" ||
    geography(mention.country ?? "") === "hong kong"
      ? ["hk"]
      : []),
  ].filter(Boolean);
  const normalized = normalize(name).replace(/\s/g, "");
  const suffix = suffixes.find(
    (value) =>
      normalized.endsWith(value) && normalized.length - value.length >= 6,
  );
  return suffix ? normalized.slice(0, -suffix.length) : name;
}
