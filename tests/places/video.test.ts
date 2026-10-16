import { describe, expect, it, vi } from "vitest";
import {
  createGeminiVideoExtractor,
  downloadVideo,
} from "../../src/features/places/video";

const config = { GEMINI_API_KEY: "synthetic", GEMINI_MODEL: "synthetic" };
const url = "https://video.cdninstagram.com/reel.mp4?signature=private";
const bytes = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 0, 0, 0, 0]);
const response = () =>
  new Response(bytes, { headers: { "content-type": "video/mp4" } });
const place = {
  name: "Cafe Test",
  evidence: "Cafe Test in Berlin",
  city: "Berlin",
  country: "Germany",
};

describe("video fallback", () => {
  it.each([
    undefined,
    "https://www.instagram.com/reel/example/",
    "http://video.cdninstagram.com/reel.mp4",
    "https://video.cdninstagram.com.evil.test/reel.mp4",
    "https://user:secret@video.cdninstagram.com/reel.mp4",
    "https://video.cdninstagram.com:444/reel.mp4",
    "https://127.0.0.1/reel.mp4",
  ])(
    "rejects unsupported media URLs before any request: %s",
    async (source) => {
      const http = vi.fn<typeof fetch>();
      expect(await downloadVideo(source, http)).toBeUndefined();
      expect(http).not.toHaveBeenCalled();
    },
  );
  it("fetches direct media without credentials or redirects and sends inline bytes to Gemini", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response());
    const generate = vi.fn().mockResolvedValue(
      JSON.stringify({
        mentions: [{ place, source: "audio", timestampSeconds: 12 }],
      }),
    );
    const extract = createGeminiVideoExtractor(config, {
      fetch: http,
      generate,
    });
    expect(
      await extract({ url, caption: "Berlin recommendations", unresolved: [] }),
    ).toEqual({ kind: "extracted", value: { mentions: [place] } });
    expect(http).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ redirect: "error", credentials: "omit" }),
    );
    expect(generate).toHaveBeenCalledWith(
      { mimeType: "video/mp4", data: bytes.toString("base64") },
      expect.stringContaining("Berlin recommendations"),
    );
  });
  it("rejects HTML and falsely labelled video without invoking Gemini", async () => {
    for (const contentType of ["text/html", "video/mp4"]) {
      const generate = vi.fn();
      const extract = createGeminiVideoExtractor(config, {
        fetch: async () =>
          new Response("<html>Login</html>", {
            headers: { "content-type": contentType },
          }),
        generate,
      });
      expect(await extract({ url, caption: "", unresolved: [] })).toEqual({
        kind: "unavailable",
      });
      expect(generate).not.toHaveBeenCalled();
    }
  });
  it("bounds both declared and streamed media length", async () => {
    const declared = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(bytes, {
        headers: {
          "content-type": "video/mp4",
          "content-length": String(13 * 1024 * 1024),
        },
      }),
    );
    expect(await downloadVideo(url, declared)).toBeUndefined();
    const cancelled = vi.fn();
    const streamed = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(12 * 1024 * 1024 + 1));
          },
          cancel: cancelled,
        }),
        { headers: { "content-type": "video/mp4" } },
      ),
    );
    expect(await downloadVideo(url, streamed)).toBeUndefined();
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("rejects out-of-range timestamps and unsupported visual guesses", async () => {
    const extract = createGeminiVideoExtractor(config, {
      fetch: async () => response(),
      generate: async () =>
        JSON.stringify({
          mentions: [
            { place, source: "visual", timestampSeconds: 1 },
            { place, source: "audio", timestampSeconds: 181 },
          ],
        }),
    });
    expect(await extract({ url, caption: "", unresolved: [] })).toEqual({
      kind: "invalid-output",
    });
  });
  it("contains provider failures and logs no signed URLs, captions or provider errors", async () => {
    const log = vi.fn();
    const extract = createGeminiVideoExtractor(config, {
      fetch: async () => {
        throw new Error(url);
      },
      log,
      generate: vi.fn(),
    });
    expect(
      await extract({ url, caption: "private caption", unresolved: [] }),
    ).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /signature|private|cdninstagram/,
    );
  });
});
