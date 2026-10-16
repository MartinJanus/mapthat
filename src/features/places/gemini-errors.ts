// Return only allowlisted categories; provider messages can contain private inputs.
export function geminiFailureDetails(error: Error) {
  const rawStatus = "status" in error ? error.status : undefined;
  const status =
    typeof rawStatus === "number" &&
    Number.isInteger(rawStatus) &&
    rawStatus >= 400 &&
    rawStatus <= 599
      ? rawStatus
      : 0;
  let reason = "transport_or_sdk";
  if (status === 400) reason = "invalid_request";
  else if (status === 402) reason = "payment_required";
  else if (status === 401 || status === 403) reason = "permission_denied";
  else if (status === 404) reason = "model_or_resource_not_found";
  else if (status === 429) reason = "rate_limit_or_quota";
  else if (status === 408 || status === 504) reason = "timeout";
  else if (status >= 500) reason = "provider_unavailable";
  else if (error.name === "AbortError" || error.name === "TimeoutError")
    reason = "timeout";
  return { status, reason };
}
