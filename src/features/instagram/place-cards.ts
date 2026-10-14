import type { GenericElement } from "./client";
import { createPlaceSearchLinks } from "../places/caption";
import type { CaptionExtraction, PlaceSearchLinks } from "../places/caption";
import type { MatchPlace, MatchedPlace } from "../places/google";

export type PlaceCard = {
  readonly element: GenericElement;
  readonly fallback: string;
  readonly attributions: readonly string[];
};

export async function preparePlaceCards(
  extraction: CaptionExtraction,
  match?: MatchPlace,
) {
  const cards: PlaceCard[] = [];
  const texts: string[] = [];
  for (const mention of extraction.mentions) {
    if (!mention.city && !mention.country) {
      texts.push(
        `I found ${mention.name}, but the caption does not give enough location detail to identify the right place.`,
      );
      continue;
    }
    if (!match) {
      const links = createPlaceSearchLinks(mention);
      cards.push(
        buildCard(mention.name, "Caption candidate (not verified)", links),
      );
      continue;
    }
    const result = await match(mention);
    switch (result.kind) {
      case "matched":
      case "no-photo":
        cards.push(buildMatchedCard(result.place));
        break;
      case "ambiguous":
        texts.push(
          `I found ${mention.name}, but couldn't confidently match it to one location.`,
        );
        break;
      case "not-found":
        texts.push(`I couldn't find a matching location for ${mention.name}.`);
        break;
      case "unavailable": {
        const links = createPlaceSearchLinks(mention);
        texts.push(
          `${mention.name}: place matching is unavailable. These are caption search links, not a verified location.\nGoogle Maps: ${links.googleMaps}\nApple Maps: ${links.appleMaps}`,
        );
        break;
      }
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  }
  return { cards, texts };
}

function buildMatchedCard(place: MatchedPlace): PlaceCard {
  const label =
    place.confidence === "medium"
      ? "Google Maps · Likely match"
      : "Google Maps";
  const card = buildCard(
    place.name,
    `${label} · ${place.address}`,
    place.links,
  );
  const credits =
    place.photoCredits ?? (place.photoCredit ? [place.photoCredit] : []);
  const credit =
    credits.length === 1 && credits[0] && credits[0].displayName.length <= 20
      ? credits[0]
      : undefined;
  return {
    element: {
      ...card.element,
      ...(place.imageUrl ? { image_url: place.imageUrl } : {}),
      ...(credit
        ? {
            subtitle: truncate(`${label} · ${place.address}`, 80),
            buttons: [
              ...card.element.buttons,
              {
                type: "web_url",
                title:
                  credit.displayName.length <= 20
                    ? credit.displayName
                    : "Photo credit",
                url: credit.uri,
              },
            ],
          }
        : {}),
    },
    fallback: `${place.name}\n${place.address}\n${label}\nGoogle Maps: ${place.links.googleMaps}\nApple Maps: ${place.links.appleMaps}${place.attributions.map((value) => `\n${value.provider}: ${value.providerUri}`).join("")}`,
    attributions: [
      ...place.attributions.map(
        (value) => `${value.provider}: ${value.providerUri}`,
      ),
      ...credits.map(
        (value) =>
          `Photo of ${place.name} by ${value.displayName}: ${value.uri}`,
      ),
    ],
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
    attributions: [],
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
