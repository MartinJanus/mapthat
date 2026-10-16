import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import axios from "axios";
import { describe, expect, it } from "vitest";
import { createWebhookHandlers } from "../../src/features/instagram/webhook";
import { createInstagramMessenger } from "../../src/features/instagram/client";
import { googlePlaceIdSchema } from "../../src/features/places/google";

const environment = {
  INSTAGRAM_APP_SECRET: "synthetic-secret",
  INSTAGRAM_ACCESS_TOKEN: "synthetic-token",
  INSTAGRAM_ACCOUNT_ID: "10001",
};

describe("signed Reel webhook to Instagram cards", () => {
  it.each([200, 400])(
    "delivers the Maps result through the API when the card endpoint returns %s",
    async (cardStatus) => {
      const requests: unknown[] = [];
      const server = createServer(async (request, reply) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        requests.push(body);
        const card = requests.length === 3;
        reply.writeHead(card ? cardStatus : 200, {
          "Content-Type": "application/json",
        });
        reply.end(
          requests.length === 1
            ? '{"success":true}'
            : card && cardStatus === 400
              ? '{"error":{"code":100}}'
              : '{"recipient_id":"20002","message_id":"outgoing"}',
        );
      });
      const listening = once(server, "listening");
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      if (!address || typeof address === "string")
        throw new TypeError("Expected TCP address");
      const http = axios.create({ proxy: false });
      http.interceptors.request.use((request) => {
        const url = new URL(request.url ?? "");
        expect(url.origin).toBe("https://graph.instagram.com");
        request.url = `http://127.0.0.1:${address.port}${url.pathname}`;
        return request;
      });
      const handlers = createWebhookHandlers({
        environment: () => environment,
        captureReel: async () => {},
        messenger: (config) => createInstagramMessenger(config, http),
        extract: async () => ({
          kind: "extracted",
          value: {
            mentions: [
              {
                name: "Cafe Test",
                evidence: "Cafe Test in Berlin",
                city: "Berlin",
                country: "Germany",
              },
            ],
          },
        }),
        match: async () => ({
          kind: "matched",
          place: {
            id: googlePlaceIdSchema.parse("place-1"),
            name: "Cafe Test",
            address: "Berlin, Germany",
            confidence: "high",
            attributions: [],
            links: {
              googleMaps:
                "https://www.google.com/maps/search/?api=1&query=52.52,13.405&query_place_id=place-1",
              appleMaps:
                "https://maps.apple.com/?q=52.52,13.405&ll=52.52,13.405",
            },
            imageUrl: "https://images.example.test/photo.jpg",
            photoSourceUrl: "https://maps.google.com/maps/photo/first",
            photoCredits: [
              {
                displayName: "Photo Author",
                uri: "https://maps.google.com/contrib/author",
              },
            ],
          },
        }),
        log: () => {},
      });
      const body = JSON.stringify({
        object: "instagram",
        entry: [
          {
            id: "10001",
            messaging: [
              {
                sender: { id: "20002" },
                recipient: { id: "10001" },
                timestamp: Date.now(),
                message: {
                  mid: "incoming-reel",
                  attachments: [
                    {
                      type: "ig_reel",
                      payload: { title: "Cafe Test in Berlin" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      const signature = `sha256=${createHmac("sha256", environment.INSTAGRAM_APP_SECRET).update(body).digest("hex")}`;
      try {
        const response = await handlers.POST(
          new Request("https://example.test/api/instagram/webhook", {
            method: "POST",
            body,
            headers: { "X-Hub-Signature-256": signature },
          }),
        );
        expect(response.status).toBe(200);
        expect(requests[0]).toMatchObject({
          sender_action: "react",
          payload: { message_id: "incoming-reel", reaction: "👀" },
        });
        expect(requests[2]).toMatchObject({
          message: {
            attachment: {
              payload: {
                elements: [
                  {
                    title: "Cafe Test",
                    image_url: "https://images.example.test/photo.jpg",
                    default_action: {
                      type: "web_url",
                      url: "https://maps.google.com/maps/photo/first",
                    },
                    buttons: [
                      {
                        title: "Google Maps",
                        url: "https://www.google.com/maps/search/?api=1&query=52.52,13.405&query_place_id=place-1",
                      },
                      {
                        title: "Apple Maps",
                        url: "https://maps.apple.com/?q=52.52,13.405&ll=52.52,13.405",
                      },
                    ],
                  },
                ],
              },
            },
          },
        });
        if (cardStatus === 400) {
          expect(requests).toHaveLength(4);
          expect(requests[3]).toMatchObject({
            message: {
              text: expect.stringContaining(
                "Google Maps: https://www.google.com/maps/search/",
              ),
            },
          });
        } else expect(requests).toHaveLength(3);
      } finally {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
      }
    },
  );
});
