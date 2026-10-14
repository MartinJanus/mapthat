import { z } from "zod";
import type { PlaceMention, PlaceSearchLinks } from "./caption";

export const googlePlacesConfigSchema = z
  .object({ GOOGLE_PLACES_API_KEY: z.string().trim().min(1) })
  .readonly();
export type GooglePlacesConfig = z.infer<typeof googlePlacesConfigSchema>;
export const googlePlaceIdSchema = z
  .string()
  .min(1)
  .max(255)
  .brand<"GooglePlaceId">();
export const publicUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.searchParams.has("key")
  );
});
const attributionSchema = z
  .object({
    displayName: z.string().min(1),
    uri: z
      .string()
      .transform((value) => (value.startsWith("//") ? `https:${value}` : value))
      .pipe(publicUrlSchema),
  })
  .readonly();
const photoSchema = z.object({
  name: z.string().regex(/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/),
  authorAttributions: z.array(attributionSchema).default([]),
});
const placeSchema = z.object({
  id: googlePlaceIdSchema,
  displayName: z.object({ text: z.string().min(1) }),
  formattedAddress: z.string().min(1),
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  addressComponents: z.array(
    z.object({
      longText: z.string(),
      shortText: z.string().optional(),
      types: z.array(z.string()),
    }),
  ),
  photos: z.array(photoSchema).default([]),
  attributions: z
    .array(
      z.object({ provider: z.string().min(1), providerUri: publicUrlSchema }),
    )
    .default([]),
});
export const searchSchema = z.object({
  places: z.array(placeSchema).max(20).default([]),
});
export type GooglePlace = z.infer<typeof placeSchema>;
export type MatchedPlace = {
  readonly id: GooglePlace["id"];
  readonly name: string;
  readonly address: string;
  readonly confidence: "high";
  readonly links: PlaceSearchLinks;
  readonly imageUrl?: string;
  readonly photoCredit?: z.infer<typeof attributionSchema>;
  readonly photoCredits?: readonly z.infer<typeof attributionSchema>[];
  readonly attributions: readonly {
    readonly provider: string;
    readonly providerUri: string;
  }[];
};
export type PlaceMatchResult =
  | { readonly kind: "matched"; readonly place: MatchedPlace }
  | { readonly kind: "no-photo"; readonly place: MatchedPlace }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable" };
export type MatchPlace = (mention: PlaceMention) => Promise<PlaceMatchResult>;
