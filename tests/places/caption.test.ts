import { describe, expect, it } from "vitest";
import {
  parseCaptionExtraction,
  prepareCaptionPlaceResults,
} from "../../src/features/places/caption";
import { createGeminiCaptionExtractor } from "../../src/features/places/gemini";

const extractionJson = JSON.stringify({
  mentions: [
    {
      name: "Yat Lok Restaurant",
      evidence: "Yat Lok Restaurant – World-famous roast goose spot",
      city: "Hong Kong",
      country: "China",
    },
  ],
});

describe("caption place extraction", () => {
  it("returns validated place mentions from structured provider output", async () => {
    const extract = createGeminiCaptionExtractor(
      { GEMINI_API_KEY: "synthetic-key", GEMINI_MODEL: "synthetic-model" },
      async () => extractionJson,
    );

    const result = await extract(
      "Yat Lok Restaurant – World-famous roast goose spot",
    );

    expect(result).toEqual({
      kind: "extracted",
      value: JSON.parse(extractionJson),
    });
  });

  it("returns no-place when the provider finds no recommendations", () => {
    const result = parseCaptionExtraction('{"mentions":[]}');

    expect(result).toEqual({ kind: "no-place" });
  });

  it("rejects malformed or schema-invalid provider output", () => {
    expect(parseCaptionExtraction("not JSON")).toEqual({
      kind: "invalid-output",
    });
    expect(
      parseCaptionExtraction('{"mentions":[{"name":"Missing evidence"}]}'),
    ).toEqual({
      kind: "invalid-output",
    });
  });

  it("treats an empty provider response as invalid output", async () => {
    const extract = createGeminiCaptionExtractor(
      { GEMINI_API_KEY: "synthetic-key", GEMINI_MODEL: "synthetic-model" },
      async () => undefined,
    );

    expect(await extract("No provider output")).toEqual({
      kind: "invalid-output",
    });
  });

  it("creates Maps search links only when caption geography narrows the place", () => {
    const extracted = parseCaptionExtraction(extractionJson);
    if (extracted.kind !== "extracted") throw new TypeError("Expected places");
    const results = prepareCaptionPlaceResults(extracted.value);

    expect(results).toEqual([
      {
        kind: "candidate",
        mention: extracted.value.mentions[0],
        links: {
          googleMaps:
            "https://www.google.com/maps/search/?api=1&query=Yat%20Lok%20Restaurant%2C%20Hong%20Kong%2C%20China",
          appleMaps:
            "https://maps.apple.com/?q=Yat%20Lok%20Restaurant%2C%20Hong%20Kong%2C%20China",
        },
      },
    ]);
  });

  it("marks a place without geographic context as ambiguous", () => {
    const extracted = parseCaptionExtraction(
      '{"mentions":[{"name":"Central Perk","evidence":"Go to Central Perk","city":null,"country":null}]}',
    );
    if (extracted.kind !== "extracted") throw new TypeError("Expected places");

    expect(prepareCaptionPlaceResults(extracted.value)).toEqual([
      {
        kind: "ambiguous",
        mention: extracted.value.mentions[0],
      },
    ]);
  });
});

describe("caption evidence", () => {
  it("rejects an invented supporting quote", async () => {
    const extract = createGeminiCaptionExtractor(
      { GEMINI_API_KEY: "synthetic-key", GEMINI_MODEL: "synthetic-model" },
      async () => extractionJson,
    );
    expect(await extract("A video with no named recommendations")).toEqual({
      kind: "invalid-output",
      reason: "ungrounded",
    });
  });
});

describe("caption recovery", () => {
  const config = { GEMINI_API_KEY: "synthetic", GEMINI_MODEL: "synthetic" };
  const good = {
    name: "Joe's Cafe",
    evidence: "Joe's Cafe - great coffee",
    city: "Berlin",
    country: "Germany",
  };
  it("normalizes quote typography, dashes and whitespace without rejecting the caption", async () => {
    const extract = createGeminiCaptionExtractor(config, async () =>
      JSON.stringify({ mentions: [good] }),
    );
    expect((await extract("Joe’s Cafe –\n great coffee")).kind).toBe(
      "extracted",
    );
  });
  it("retains valid siblings when one item has an invalid schema or invented evidence", async () => {
    const extract = createGeminiCaptionExtractor(config, async () =>
      JSON.stringify({
        mentions: [
          good,
          { name: "invalid" },
          { ...good, name: "Invented", evidence: "Not actually present" },
        ],
      }),
    );
    expect(await extract(good.evidence)).toEqual({
      kind: "extracted",
      value: { mentions: [good] },
    });
  });
  it("does not accept paraphrased or case-changed evidence", async () => {
    const extract = createGeminiCaptionExtractor(config, async () =>
      JSON.stringify({ mentions: [good] }),
    );
    expect(await extract("Joe's Cafe has great coffee")).toEqual({
      kind: "invalid-output",
      reason: "ungrounded",
    });
  });
  it("drops an invented address hint while retaining a grounded recommendation", async () => {
    const extract = createGeminiCaptionExtractor(config, async () =>
      JSON.stringify({ mentions: [{ ...good, addressHint: "Fake Street" }] }),
    );
    expect(await extract(good.evidence)).toEqual({
      kind: "extracted",
      value: { mentions: [{ ...good, addressHint: null }] },
    });
  });
});
