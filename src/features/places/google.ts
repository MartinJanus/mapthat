import ky, { NetworkError, TimeoutError, ResponseSizeError } from "ky";
import { z } from "zod";
import type { PlaceMention } from "./caption";
import { publicUrlSchema, searchSchema } from "./google-model";
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
): MatchPlace {
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
            textQuery: [mention.name, mention.city, mention.country]
              .filter(Boolean)
              .join(", "),
            pageSize: 20,
            languageCode: "en",
          },
        },
      );
      if (!response.ok) return { kind: "unavailable" };
      const parsed = searchSchema.safeParse(await response.json<unknown>());
      if (!parsed.success) return { kind: "unavailable" };
      const result = selectPlaceMatch(mention, parsed.data.places);
      if (result.kind !== "matched") return result;
      const selected = parsed.data.places.findLast(
        (place) => place.id === result.place.id,
      );
      const photo = selected?.photos[0];
      if (!photo) return { kind: "no-photo", place: result.place };
      const imageUrl = await loadPhoto(photo.name);
      return imageUrl
        ? {
            kind: "matched",
            place: {
              ...result.place,
              imageUrl,
              photoCredit: photo.authorAttributions[0],
              photoCredits: photo.authorAttributions,
            },
          }
        : { kind: "no-photo", place: result.place };
    } catch (error) {
      if (
        error instanceof NetworkError ||
        error instanceof TimeoutError ||
        error instanceof ResponseSizeError ||
        error instanceof SyntaxError
      )
        return { kind: "unavailable" };
      throw error;
    }
  };

  async function loadPhoto(name: string): Promise<string | undefined> {
    try {
      const response = await client.get(
        `https://places.googleapis.com/v1/${name}/media`,
        { searchParams: { maxWidthPx: 800, skipHttpRedirect: true } },
      );
      if (!response.ok) return undefined;
      const parsed = z
        .object({ photoUri: publicUrlSchema })
        .safeParse(await response.json<unknown>());
      return parsed.success ? parsed.data.photoUri : undefined;
    } catch (error) {
      if (
        error instanceof NetworkError ||
        error instanceof TimeoutError ||
        error instanceof ResponseSizeError ||
        error instanceof SyntaxError
      )
        return undefined;
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
      score: nameScore(mention.name, place.displayName.text),
    }))
    .sort((a, b) => b.score - a.score);
  const first = ranked[0];
  const second = ranked[1];
  if (
    !first ||
    !normalize(mention.name) ||
    normalize(mention.name) !== normalize(first.place.displayName.text) ||
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
      confidence: "high",
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
  if (!normalize(expected) || !normalize(actual)) return 0;
  const a = new Set(normalize(expected).split(" "));
  const b = new Set(normalize(actual).split(" "));
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
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
                ].includes(type),
          ) &&
          [component.longText, component.shortText].some(
            (text) => text && normalize(text) === normalize(value),
          ),
      ),
  );
}
