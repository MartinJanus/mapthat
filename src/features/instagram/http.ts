import axios, { AxiosError } from "axios";
import type { AxiosRequestConfig } from "axios";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type InstagramRequestFailure = "response" | "transport";

export function createInstagramRequestOptions(
  accessToken: string,
): AxiosRequestConfig {
  return {
    headers: { Authorization: `Bearer ${accessToken}` },
    adapter: "http",
    timeout: REQUEST_TIMEOUT_MS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    maxRedirects: 0,
    maxContentLength: MAX_RESPONSE_BYTES,
    responseType: "text",
    validateStatus: () => true,
  };
}

export function classifyInstagramRequestFailure(
  error: unknown,
): InstagramRequestFailure | undefined {
  if (error instanceof SyntaxError) return "response";
  if (!axios.isAxiosError(error)) return undefined;
  return error.code === AxiosError.ERR_BAD_RESPONSE ? "response" : "transport";
}
