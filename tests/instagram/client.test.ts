import { createServer } from "node:http";
import { once } from "node:events";
import axios from "axios";
import { describe, expect, it } from "vitest";
import {
  instagramIdSchema,
  webhookConfigSchema,
} from "../../src/features/instagram/config";
import {
  createInstagramSender,
  createInstagramTextSender,
  FIXED_REPLY,
  reactToMessage,
  sendGenericTemplate,
} from "../../src/features/instagram/client";

const config = webhookConfigSchema.parse({
  INSTAGRAM_APP_SECRET: "synthetic-app-secret",
  INSTAGRAM_ACCESS_TOKEN: "synthetic-access-token",
  INSTAGRAM_ACCOUNT_ID: "10001",
});
const recipient = instagramIdSchema.parse("20002");

type ObservedRequest = {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly authorization: string | undefined;
  readonly body: unknown;
};

async function withApi(
  response: {
    readonly status: number;
    readonly body: string;
    readonly location?: string;
  },
  run: (
    sender: ReturnType<typeof createInstagramSender>,
    requests: ObservedRequest[],
    http: ReturnType<typeof axios.create>,
  ) => Promise<void>,
) {
  const requests: ObservedRequest[] = [];
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    reply.writeHead(response.status, {
      "Content-Type": "application/json",
      ...(response.location ? { Location: response.location } : {}),
    });
    reply.end(response.body);
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string")
    throw new TypeError("Expected TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const http = axios.create({ proxy: false });
  http.interceptors.request.use((request) => {
    if (!request.url) throw new TypeError("Expected API URL");
    const url = new URL(request.url);
    expect(url.origin).toBe("https://graph.instagram.com");
    request.url = `${origin}${url.pathname}`;
    return request;
  });
  try {
    await run(createInstagramSender(config, http), requests, http);
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

describe("Instagram official API adapter", () => {
  it("reacts to the incoming message ID when acknowledging a Reel", async () => {
    await withApi(
      { status: 200, body: '{"success":true}' },
      async (_, requests, http) => {
        const result = await reactToMessage(
          config,
          recipient,
          "incoming-reel",
          "👀",
          http,
        );
        expect(result).toEqual({ kind: "sent" });
        expect(requests).toEqual([
          {
            method: "POST",
            path: "/v25.0/10001/messages",
            authorization: "Bearer synthetic-access-token",
            body: {
              recipient: { id: "20002" },
              sender_action: "react",
              payload: { message_id: "incoming-reel", reaction: "👀" },
            },
          },
        ]);
      },
    );
  });

  it.each(["{}", '{"success":false}', "not JSON"])(
    "rejects a malformed reaction response %s",
    async (body) => {
      await withApi({ status: 200, body }, async (_, requests, http) => {
        expect(
          await reactToMessage(config, recipient, "incoming", "👀", http),
        ).toEqual({ kind: "failed", reason: "response" });
        expect(requests).toHaveLength(1);
      });
    },
  );

  it("sends both Maps buttons and an image when given a place card", async () => {
    const elements = [
      {
        title: "Yat Lok Restaurant",
        subtitle: "Hong Kong",
        image_url: "https://images.example.test/place.jpg",
        buttons: [
          {
            type: "web_url" as const,
            title: "Google Maps",
            url: "https://www.google.com/maps/search/?api=1&query=Yat%20Lok",
          },
          {
            type: "web_url" as const,
            title: "Apple Maps",
            url: "https://maps.apple.com/?q=Yat%20Lok",
          },
        ],
      },
    ];
    await withApi(
      { status: 200, body: '{"recipient_id":"20002","message_id":"card"}' },
      async (_, requests, http) => {
        expect(
          await sendGenericTemplate(config, recipient, elements, http),
        ).toEqual({ kind: "sent" });
        expect(requests[0]?.body).toEqual({
          recipient: { id: "20002" },
          message: {
            attachment: {
              type: "template",
              payload: { template_type: "generic", elements },
            },
          },
        });
      },
    );
  });

  it("rejects oversized carousels and invalid images before making a request", async () => {
    const element = {
      title: "Place",
      buttons: [
        {
          type: "web_url" as const,
          title: "Google Maps",
          url: "https://www.google.com/maps",
        },
      ],
    };
    await withApi({ status: 200, body: "{}" }, async (_, requests, http) => {
      expect(
        await sendGenericTemplate(
          config,
          recipient,
          Array.from({ length: 11 }, () => element),
          http,
        ),
      ).toEqual({ kind: "failed", reason: "response" });
      expect(
        await sendGenericTemplate(
          config,
          recipient,
          [{ ...element, image_url: "http://example.test/private.jpg" }],
          http,
        ),
      ).toEqual({ kind: "failed", reason: "response" });
      expect(requests).toEqual([]);
    });
  });

  it("sends a fixed reply with a private bearer token when a valid recipient is supplied", async () => {
    await withApi(
      {
        status: 200,
        body: '{"recipient_id":"20002","message_id":"synthetic-reply-id"}',
      },
      async (send, requests) => {
        const result = await send(recipient);
        expect(result).toEqual({ kind: "sent" });
        expect(requests).toEqual([
          {
            method: "POST",
            path: "/v25.0/10001/messages",
            authorization: "Bearer synthetic-access-token",
            body: {
              recipient: { id: "20002" },
              message: { text: FIXED_REPLY },
            },
          },
        ]);
      },
    );
  });

  it.each([400, 401, 429, 500])(
    "reports HTTP %s without retrying a send",
    async (status) => {
      await withApi(
        { status, body: '{"error":{"message":"synthetic-provider-error"}}' },
        async (send, requests) => {
          const result = await send(recipient);
          expect(result).toEqual({ kind: "failed", reason: "http" });
          expect(requests).toHaveLength(1);
        },
      );
    },
  );

  it.each(["not JSON", "{}", '{"recipient_id":"99999","message_id":"reply"}'])(
    "reports malformed successful responses %s",
    async (body) => {
      await withApi({ status: 200, body }, async (send, requests) => {
        const result = await send(recipient);
        expect(result).toEqual({ kind: "failed", reason: "response" });
        expect(requests).toHaveLength(1);
      });
    },
  );

  it("returns a sanitized result when the transport fails", async () => {
    const http = axios.create();
    http.interceptors.request.use((request) => {
      request.signal = AbortSignal.abort();
      return request;
    });
    const send = createInstagramSender(config, http);
    const result = await send(recipient);
    expect(result).toEqual({ kind: "failed", reason: "transport" });
  });

  it("does not follow redirects when the API redirects a send", async () => {
    await withApi(
      { status: 302, body: "", location: "/redirect" },
      async (send, requests) => {
        expect(await send(recipient)).toEqual({
          kind: "failed",
          reason: "http",
        });
        expect(requests).toHaveLength(1);
      },
    );
  });

  it("rejects successful responses larger than the response limit", async () => {
    await withApi(
      { status: 200, body: "x".repeat(65 * 1024) },
      async (send, requests) => {
        expect(await send(recipient)).toEqual({
          kind: "failed",
          reason: "response",
        });
        expect(requests).toHaveLength(1);
      },
    );
  });

  it("does not send text that exceeds Instagram's byte limit", async () => {
    const send = createInstagramTextSender(config);

    const result = await send(recipient, "x".repeat(1001));

    expect(result).toEqual({ kind: "failed", reason: "response" });
  });
});
