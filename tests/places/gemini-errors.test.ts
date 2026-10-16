import { describe, expect, it } from "vitest";
import { geminiFailureDetails } from "../../src/features/places/gemini-errors";

describe("Gemini failure diagnostics", () => {
  it.each([
    [400, "invalid_request"],
    [401, "permission_denied"],
    [403, "permission_denied"],
    [404, "model_or_resource_not_found"],
    [408, "timeout"],
    [429, "rate_limit_or_quota"],
    [500, "provider_unavailable"],
    [503, "provider_unavailable"],
    [504, "timeout"],
  ])("categorizes HTTP %i safely", (status, reason) => {
    const error = Object.assign(new Error("private caption and API key"), {
      status,
    });
    expect(geminiFailureDetails(error)).toEqual({ status, reason });
  });

  it("recognizes aborted requests", () => {
    const error = new Error("private provider response");
    error.name = "AbortError";
    expect(geminiFailureDetails(error)).toEqual({
      status: 0,
      reason: "timeout",
    });
  });

  it("excludes arbitrary status values, names and nested provider data", () => {
    const error = Object.assign(new Error("private caption and API key"), {
      status: "secret",
      name: "private",
      response: { body: "private" },
    });
    expect(geminiFailureDetails(error)).toEqual({
      status: 0,
      reason: "transport_or_sdk",
    });
  });
});
