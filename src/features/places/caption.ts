import { z } from "zod";

const optionalLocationSchema = z.string().trim().min(1).max(120).nullable();

export const placeMentionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    evidence: z.string().trim().min(1).max(500),
    city: optionalLocationSchema,
    country: optionalLocationSchema,
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
  | { readonly kind: "invalid-output" };

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

  const parsed = captionExtractionSchema.safeParse(input);
  if (!parsed.success) return { kind: "invalid-output" };
  return parsed.data.mentions.length === 0
    ? { kind: "no-place" }
    : { kind: "extracted", value: parsed.data };
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
  const encodedQuery = encodeURIComponent(query);
  return {
    googleMaps: `https://www.google.com/maps/search/?api=1&query=${encodedQuery}`,
    appleMaps: `https://maps.apple.com/?q=${encodedQuery}`,
  };
}
