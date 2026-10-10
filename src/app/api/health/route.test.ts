import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns a non-cacheable JSON health response when called", async () => {
    const response = GET();
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(
      /^application\/json\b/,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({ status: "ok" });
  });
});
