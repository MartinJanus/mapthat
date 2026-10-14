import ky, { NetworkError, TimeoutError, ResponseSizeError } from "ky";
import { z } from "zod";
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
  const log = options.log ?? ((record) => console.warn(JSON.stringify(record)));
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
  return async (mention) => {
    if (!mention.city && !mention.country) return { kind: "ambiguous" };
    try {
      const response = await client.post(
        "https://places.googleapis.com/v1/places:searchText",
        {
          headers: {
            "X-Goog-FieldMask":
              "places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents,places.photos,places.attributions",
          },
          json: {
            textQuery: [searchName(mention), mention.city, mention.country]
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
      if (parsed.data.places.length > 0 && places.length === 0) {
        diagnostic("search", "response_schema");
        return { kind: "unavailable" };
      }
      const result = selectPlaceMatch(mention, places);
      if (result.kind !== "matched") return result;
      const selected = places.find((place) => place.id === result.place.id);
      // Invalid optional photo metadata must not discard a valid place.
      for (const rawPhoto of selected?.photos.slice(0, 3) ?? []) {
        const photo = photoSchema.safeParse(rawPhoto);
        if (!photo.success) {
          diagnostic("photo", "metadata_schema");
          continue;
        }
        const imageUrl = await loadPhoto(photo.data.name);
        if (imageUrl) {
          return {
            kind: "matched",
            place: {
              ...result.place,
              imageUrl,
              photoCredit: photo.data.authorAttributions[0],
              photoCredits: photo.data.authorAttributions,
            },
          };
        }
      }
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
): PlaceMatchResult {
  if (places.length === 0) return { kind: "not-found" };
  if (!mention.city && !mention.country) return { kind: "ambiguous" };
  const unique = [
    ...new Map(places.map((place) => [place.id, place])).values(),
  ];
  const ranked = unique
    .filter((place) => geographicMatch(mention, place))
    .map((place) => ({
      place,
      score: nameScore(searchName(mention), place.displayName.text),
    }))
    .sort((a, b) => b.score - a.score);
  const first = ranked[0];
  const second = ranked[1];
  if (
    !first ||
    first.score < 0.8 ||
    (second && first.score - second.score < 0.2)
  )
    return { kind: "ambiguous" };
  const query = `${first.place.location.latitude},${first.place.location.longitude}`;
  return {
    kind: "matched",
    place: {
      id: first.place.id,
      name: first.place.displayName.text,
      address: first.place.formattedAddress,
      confidence:
        normalize(mention.name) === normalize(first.place.displayName.text)
          ? "high"
          : "medium",
      links: {
        googleMaps: `https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=${encodeURIComponent(first.place.id)}`,
        appleMaps: `https://maps.apple.com/?q=${query}&ll=${query}`,
      },
      attributions: first.place.attributions,
    },
  };
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
