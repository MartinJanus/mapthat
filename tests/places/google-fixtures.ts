import { createServer } from "node:http";
import { once } from "node:events";
import ky from "ky";
import { expect } from "vitest";
import { createGooglePlacesMatcher } from "../../src/features/places/google";
import type { MatchPlace } from "../../src/features/places/google";

export const mention = {
  name: "Cafe Test",
  city: "Berlin",
  country: "Germany",
  evidence: "Cafe Test in Berlin, Germany",
};
export function place(id = "place-1", name = "Cafe Test", city = "Berlin") {
  return {
    id,
    displayName: { text: name },
    formattedAddress: `Test Street, ${city}, Germany`,
    location: { latitude: 52.52, longitude: 13.405 },
    addressComponents: [
      { longText: city, types: ["locality"] },
      { longText: "Germany", shortText: "DE", types: ["country"] },
    ],
    photos: [{ name: `places/${id}/photos/first`, authorAttributions: [] }],
  };
}
type ObservedRequest = {
  readonly path: string | undefined;
  readonly key: string | string[] | undefined;
  readonly mask: string | string[] | undefined;
  readonly body: unknown;
};
export async function withPlaces(
  search: unknown,
  run: (match: MatchPlace, requests: ObservedRequest[]) => Promise<void>,
  options: {
    readonly status?: number;
    readonly photo?: unknown;
    readonly photoStatus?: number;
    readonly failedPhotoPaths?: readonly string[];
    readonly log?: (record: Readonly<Record<string, string | number>>) => void;
  } = {},
) {
  const requests: ObservedRequest[] = [];
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      path: request.url,
      key: request.headers["x-goog-api-key"],
      mask: request.headers["x-goog-fieldmask"],
      body: body ? JSON.parse(body) : undefined,
    });
    const photo = request.method === "GET";
    reply.writeHead(
      photo &&
        options.failedPhotoPaths?.includes(request.url?.split("?")[0] ?? "")
        ? 403
        : photo
          ? (options.photoStatus ?? 200)
          : (options.status ?? 200),
      { "Content-Type": "application/json" },
    );
    reply.end(
      JSON.stringify(
        photo
          ? (options.photo ?? {
              photoUri: "https://images.example.test/first.jpg",
            })
          : search,
      ),
    );
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string")
    throw new TypeError("Expected TCP address");
  const http = ky.create({
    hooks: {
      beforeRequest: [
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.origin).toBe("https://places.googleapis.com");
          return new Request(
            `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
            request,
          );
        },
      ],
    },
  });
  try {
    await run(
      createGooglePlacesMatcher(
        { GOOGLE_PLACES_API_KEY: "synthetic-google-key" },
        http,
        { log: options.log ?? (() => {}) },
      ),
      requests,
    );
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}
