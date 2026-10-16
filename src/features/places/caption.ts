import { z } from "zod";

const optionalLocationSchema = z.string().trim().min(1).max(120).nullable();

export const placeMentionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    evidence: z.string().trim().min(1).max(500),
    city: optionalLocationSchema,
    country: optionalLocationSchema,
    addressHint: optionalLocationSchema.optional(),
  })
  .strict()
  .readonly();

export const captionExtractionSchema = z
  .object({
    mentions: z.array(placeMentionSchema).max(30),
  })
  .strict()
  .readonly();

export type PlaceMention = z.infer<typeof placeMentionSchema>;

export type CaptionExtraction = z.infer<typeof captionExtractionSchema>;

export type CaptionExtractionResult =
  | { readonly kind: "extracted"; readonly value: CaptionExtraction }
  | { readonly kind: "no-place" }
  | {
      readonly kind: "invalid-output";
      readonly reason?: "ungrounded" | "provider" | "configuration";
    };

export type PlaceSearchLinks = {
  readonly appleMaps: string;
  readonly googleMaps: string;
};

export type CaptionPlaceResult =
  | {
      readonly kind: "candidate";
      readonly mention: PlaceMention;
      readonly links: PlaceSearchLinks;
    }
  | { readonly kind: "ambiguous"; readonly mention: PlaceMention };

export function parseCaptionExtraction(value: string): CaptionExtractionResult {
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: "invalid-output" };
    throw error;
  }

  const envelope = z
    .object({ mentions: z.array(z.unknown()).max(30) })
    .strict()
    .safeParse(input);
  if (!envelope.success) return { kind: "invalid-output" };
  if (envelope.data.mentions.length === 0) return { kind: "no-place" };
  const mentions = envelope.data.mentions.flatMap((raw) => {
    const mention = placeMentionSchema.safeParse(raw);
    return mention.success ? [mention.data] : [];
  });
  return mentions.length
    ? { kind: "extracted", value: { mentions } }
    : { kind: "invalid-output" };
}

export function prepareCaptionPlaceResults(
  extraction: CaptionExtraction,
): readonly CaptionPlaceResult[] {
  return extraction.mentions.map((mention) => {
    if (!mention.city && !mention.country) {
      return { kind: "ambiguous", mention };
    }
    return {
      kind: "candidate",
      mention,
      links: createPlaceSearchLinks(mention),
    };
  });
}

export function createPlaceSearchLinks(
  mention: PlaceMention,
): PlaceSearchLinks {
  const query = [mention.name, mention.city, mention.country]
    .filter((part): part is string => part !== null)
    .join(", ");
  const encodedQuery =
    encodeURIComponent(query).length <= 850
      ? encodeURIComponent(query)
      : [
          limitEncoded(mention.name, 450),
          limitEncoded(mention.city ?? "", 180),
          limitEncoded(mention.country ?? "", 180),
        ]
          .filter(Boolean)
          .join("%2C%20");
  return {
    googleMaps: `https://www.google.com/maps/search/?api=1&query=${encodedQuery}`,
    appleMaps: `https://maps.apple.com/?q=${encodedQuery}`,
  };
}

function limitEncoded(value: string, limit: number) {
  let result = "";
  for (const character of value) {
    const encoded = encodeURIComponent(character);
    if (result.length + encoded.length > limit) break;
    result += encoded;
  }
  return result;
}
