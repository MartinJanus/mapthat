import type { GenericElement } from "./client";
import {
  createDiagnosticLogger,
  placeReference,
} from "../observability/diagnostics";
import type { DiagnosticLogger } from "../observability/diagnostics";
import { createPlaceSearchLinks } from "../places/caption";
import type { CaptionExtraction, PlaceSearchLinks } from "../places/caption";
import type { MatchPlace, MatchedPlace } from "../places/google";

export type PlaceCard = {
  readonly element: GenericElement;
  readonly fallback: string;
};

export async function preparePlaceCards(
  extraction: CaptionExtraction,
  match?: MatchPlace,
  sink?: DiagnosticLogger,
) {
  const log = createDiagnosticLogger(sink);
  const cards: PlaceCard[] = [];
  for (const [index, mention] of extraction.mentions.entries()) {
    const fields = { placeIndex: index + 1, placeRef: placeReference(mention) };
    const searchCard = (label: string, reason: string) => {
      log({
        event: "instagram.place_card",
        ...fields,
        outcome: "search",
        reason,
        image: 0,
      });
      return buildCard(
        mention.name,
        [label, mention.city, mention.country].filter(Boolean).join(" · "),
        createPlaceSearchLinks(mention),
      );
    };
    if (!mention.city && !mention.country) {
      cards.push(
        searchCard("Location unclear · Search results", "missing_geography"),
      );
      continue;
    }
    if (!match) {
      cards.push(
        searchCard("Caption candidate (not verified)", "matcher_unconfigured"),
      );
      continue;
    }
    const result = await match(mention);
    switch (result.kind) {
      case "matched":
      case "no-photo":
        cards.push(
          buildMatchedCard(result.place, (record) =>
            log({ ...fields, ...record }),
          ) ?? searchCard("Search results", "provider_credits_cannot_fit"),
        );
        break;
      case "ambiguous":
        cards.push(
          searchCard("Possible locations · Search results", "ambiguous"),
        );
        break;
      case "not-found":
        cards.push(searchCard("Search results · Not verified", "not_found"));
        break;
      case "unavailable":
        cards.push(
          searchCard(
            "Search results · Matching unavailable",
            "matching_unavailable",
          ),
        );
        break;
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  }
  return { cards, texts: [] as readonly string[] };
}

function buildMatchedCard(
  place: MatchedPlace,
  log: DiagnosticLogger,
): PlaceCard | undefined {
  const label =
    place.confidence === "possible"
      ? "Google Maps · Possible match · Check address"
      : place.confidence === "medium"
        ? "Google Maps · Likely match"
        : "Google Maps";
  const providerNames = [
    ...new Set(place.attributions.map((value) => value.provider)),
  ];
  const sourceLabel = [label, ...providerNames].join(" · ");
  // Never truncate required provider names. Fall back to a caption search card.
  if (sourceLabel.length > 60) return undefined;
  let subtitle = `${sourceLabel} · ${truncate(place.address, 80 - sourceLabel.length - 3)}`;
  const credits =
    place.photoCredits ?? (place.photoCredit ? [place.photoCredit] : []);
  let imageUrl = place.imageUrl;
  let imageReason = imageUrl ? "available" : "no_usable_photo";
  let photoTarget = place.photoSourceUrl;
  if (imageUrl && !photoTarget && credits.length) {
    const credit = credits.length === 1 ? credits[0] : undefined;
    const creditLabel = credit ? ` · Photo: ${credit.displayName}` : "";
    // Legacy photo metadata can still be credited within the card.
    if (credit && sourceLabel.length + creditLabel.length + 8 <= 80) {
      subtitle = `${sourceLabel} · ${truncate(place.address, 80 - sourceLabel.length - creditLabel.length - 3)}${creditLabel}`;
      photoTarget = credit.uri;
    } else {
      // Keep the place card if its photo credits cannot fit this UI.
      imageUrl = undefined;
      imageReason = "photo_credits_cannot_fit";
    }
  }
  log({
    event: "instagram.place_card",
    outcome: "location",
    confidence: place.confidence,
    image: imageUrl ? 1 : 0,
    reason: imageReason,
  });
  const card = buildCard(place.name, subtitle, place.links);
  return {
    element: {
      ...card.element,
      ...(imageUrl ? { image_url: imageUrl } : {}),
      ...(imageUrl && photoTarget
        ? { default_action: { type: "web_url", url: photoTarget } as const }
        : {}),
    },
    fallback: `${place.name}\n${place.address}\n${sourceLabel}\nGoogle Maps: ${place.links.googleMaps}\nApple Maps: ${place.links.appleMaps}`,
  };
}

function buildCard(
  name: string,
  subtitle: string,
  links: PlaceSearchLinks,
): PlaceCard {
  return {
    element: {
      title: truncate(name, 80),
      subtitle: truncate(subtitle, 80),
      buttons: [
        { type: "web_url", title: "Google Maps", url: links.googleMaps },
        { type: "web_url", title: "Apple Maps", url: links.appleMaps },
      ],
    },
    fallback: `${name}\n${subtitle}\nGoogle Maps: ${links.googleMaps}\nApple Maps: ${links.appleMaps}`,
  };
}

function truncate(value: string, limit: number) {
  if (value.length <= limit) return value;
  let result = "";
  for (const character of value) {
    if (result.length + character.length > limit - 1) break;
    result += character;
  }
  return result + "…";
}

export function splitMessageText(text: string): readonly string[] {
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && Buffer.byteLength(current + "\n" + line, "utf8") > 1000) {
      parts.push(current);
      current = "";
    }
    if (current) current += "\n";
    for (const character of line) {
      if (Buffer.byteLength(current + character, "utf8") > 1000) {
        parts.push(current);
        current = "";
      }
      current += character;
    }
  }
  if (current) parts.push(current);
  return parts;
}
