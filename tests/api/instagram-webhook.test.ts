import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../../src/app/api/instagram/webhook/route";

afterEach(() => vi.unstubAllEnvs());

describe("/api/instagram/webhook route", () => {
  it("exposes verification through the real GET handler", async () => {
    vi.stubEnv("INSTAGRAM_VERIFY_TOKEN", "synthetic-verification-token");
    const request = new Request(
      "https://example.test/api/instagram/webhook?hub.mode=subscribe&hub.verify_token=synthetic-verification-token&hub.challenge=123",
    );
    const response = GET(request);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("123");
  });

  it("rejects unsigned notifications through the real POST handler", async () => {
    vi.stubEnv("INSTAGRAM_APP_SECRET", "synthetic-app-secret");
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "synthetic-access-token");
    vi.stubEnv("INSTAGRAM_ACCOUNT_ID", "10001");
    const response = await POST(
      new Request("https://example.test/api/instagram/webhook", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
  });
});
