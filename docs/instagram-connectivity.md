# Instagram connectivity experiment (issue #3)

## Status

The signed endpoint and official API adapter are implemented. All 60 automated
tests pass from the separate `tests/` directory, and `npm run check` passes
formatting, lint, TypeScript, tests, and the production build. On 2026-10-10,
the running production endpoint was exercised through a temporary HTTPS tunnel:
the matching challenge returned its exact value with 200, a wrong token and
unsigned/altered requests returned 403, and a signed empty batch returned 200.
Signed malformed JSON returned 400 through the local production HTTP endpoint.

Meta's dashboard verification and a real-account DM/reply are **pending**. Our
HTTPS probe is not proof of Meta verification or real-message delivery. Do not
close issue #3 until their redacted evidence is recorded here.

On 2026-10-10, the configured account's `subscribed_apps` read returned no
subscriptions. The account-level `messages` subscription was then enabled using
the official API; Meta returned HTTP 200 with `{"success":true}`. The user reports
the callback setup appears to work; explicit dashboard verification evidence and
the real DM/reply are still needed.

## Selected integration and account setup

Use **Instagram API with Instagram Login**, with a Business or Creator account.
This integration uses `graph.instagram.com`, an Instagram User access token,
and `instagram_business_basic` plus `instagram_business_manage_messages`.
It does not require the Facebook Login/Page-token integration. The API version
is pinned to **v25.0**, as used in the official messaging guide, rather than
assuming that the latest Graph API version is necessary. Upgrade deliberately.

1. Register as a Meta developer and create the MapThat app. Add the Instagram
   product/use case and select API setup with Instagram Login.
2. Add the MapThat professional account. Accept any tester invitation and grant
   the required permissions. Obtain its account ID and generate its token.
3. For the controlled experiment, enroll the sender as an eligible app tester.
   Meta's messaging guide says testers need an app role, required permissions,
   and a role on the professional account that owns the app. Record the actual
   sender/account roles used in the smoke test; do not infer public access from it.
4. Configure the webhook and subscribe to **messages**. Also enable the app's
   account-level subscription for the connected professional account. If using
   the API, this is `POST /v25.0/{IG_ID}/subscribed_apps` with
   `subscribed_fields=messages` and the account's bearer token. Successful
   callback verification alone does not establish event delivery.
5. In Instagram, enable connected tools' access to messages if that control is
   shown. Record the app mode, access levels, and account-subscription status.
6. Set the app to **Live** in the App Dashboard. Meta explicitly requires Live
   mode for webhook notifications; a successful dashboard test and accepted
   tester invitation do not establish real-message delivery in Development mode.
   Live mode does not grant Advanced Access or complete App Review.

Meta's dashboard labels can change. Follow the selected Instagram Login setup,
and do not mix its credentials/endpoints with Facebook Login instructions.

## Credentials and token lifecycle

Copy `.env.example` into ignored `.env.local`, or add values to an existing
ignored `.env`. Keep each variable in one file to avoid precedence confusion.
Next.js reads root environment files; restart the server after changing values.

| Variable                 | Meaning                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| `INSTAGRAM_ACCOUNT_ID`   | Numeric professional-account ID; not Instagram App ID                         |
| `INSTAGRAM_ACCESS_TOKEN` | Account's Instagram User access token                                         |
| `INSTAGRAM_APP_SECRET`   | App Secret of the Meta app hosting the webhook, used for signing verification |
| `INSTAGRAM_VERIFY_TOKEN` | New random nonempty value, also entered in Meta's webhook form                |
| `INSTAGRAM_API_VERSION`  | Optional; defaults to `v25.0`                                                 |

The webhook documentation specifies the app's App Secret. The Instagram App
Secret displayed in Business Login settings is used for OAuth token exchange;
check the hosting app's **App settings > Basic** and confirm with an actual signed
delivery. The verify token is chosen by us and is unrelated to either app secret.

Dashboard-generated tokens are long-lived (60 days); OAuth tokens initially
last one hour. A short-lived token can be exchanged server-side using
`GET https://graph.instagram.com/access_token` with `ig_exchange_token`.
Refresh an unexpired long-lived token at least 24 hours old using
`GET https://graph.instagram.com/refresh_access_token` with `ig_refresh_token`,
for another 60 days. Record expiry privately and refresh before it. Revocation,
lost permissions, or an expired token require renewed authorization. Automatic
OAuth, refresh scheduling, and credential rotation are not implemented here.

Never put tokens in shell command arguments/history, browser code, fixtures,
screenshots, or Git. Perform token exchange/refresh privately; those endpoints
use sensitive query parameters, so avoid URL/access logging.

## HTTPS callback verification

Use a production server for the experiment so Next.js development access logs
do not print verification query parameters:

```bash
npm run build
npm start -- --hostname 127.0.0.1 --port 3001
```

In another terminal, after installing Cloudflare's official `cloudflared` binary:

```bash
cloudflared tunnel --url http://127.0.0.1:3001
```

Enter the generated HTTPS origin plus `/api/instagram/webhook` as the **Callback
URL**. Enter your `INSTAGRAM_VERIFY_TOKEN` value in **Verify token**, then click
**Verify and save**. No interactive authentication can sit in front of this URL.
Keep both processes running; a Quick Tunnel's hostname changes on restart and
has no uptime guarantee. It is a development endpoint, not production hosting.

GET requires `hub.mode=subscribe`, the matching token, and `hub.challenge`.
It returns the challenge unchanged with HTTP 200 and `Cache-Control: no-store`.
Missing configuration returns 503; incomplete parameters return 400; a wrong
token returns 403. This endpoint does not echo configuration values.

## Event and failure behavior

POST reads up to 1 MiB of raw bytes, then compares the HMAC-SHA256 digest using
the app secret against `X-Hub-Signature-256` in constant time, **before** decoding
UTF-8 or parsing JSON. Missing/invalid signatures return 403, malformed signed
JSON/envelopes return 400, and oversized bodies return 413.

Within every entry's `messaging` batch, only ordinary text DMs addressed to the
configured account are eligible. Malformed events, foreign accounts, attachments,
read/postback notifications, own senders, echoes, self messages, deletions, and
unsupported messages are ignored. A malformed event does not discard its valid
siblings. Messages timestamped in the future or at least 24 hours ago are ignored.

Each eligible DM receives the fixed reply:

> Thanks! MapThat received your message. This is a connectivity test.

The adapter sends `POST https://graph.instagram.com/v25.0/{IG_ID}/messages`, with
`recipient.id` from the incoming sender and a private bearer header. It checks
the successful response's recipient and message ID. Requests time out after five
seconds, do not follow redirects, and have **no automatic send retries**.

Duplicate IDs are reserved before sending, including during overlapping
deliveries, and retained in process memory for 36 hours. The cache is capped at
10,000 attempts; capacity exhaustion returns 503 without evicting active
reservations. Normal authenticated batches return 200. Failed/uncertain sends
remain reserved and acknowledged to avoid a second send after an ambiguous
timeout. Inspect the failed count and send a **new** test DM after fixing the
cause; this experiment does not guarantee reply delivery or recover failed work.

There is no restart-safe persistence, shared cache across replicas, or durable
queue. Restart/hot reload loses reservations. Run one production Node process
for the smoke test. Replies happen synchronously, so large batches can exceed a
hosting request deadline. This controlled experiment does **not** establish beta
readiness, exactly-once delivery, or support for extraction/proactive messaging.

Logs contain only event names, a level, and aggregate sent/failed/ignored/
duplicate/capacity counts. They omit IDs, bodies, credentials, provider responses,
and exception details. Provider rejection, transport uncertainty, and malformed
responses all appear as failed sends; detailed provider diagnostics must be
inspected privately, not pasted into logs or committed.

## Messaging window and access requirements

Documentation checked **2026-10-10**, using Meta's official documentation through
Context7; direct requests to Meta's website were rate-limited.

- A user must initiate the conversation. Automated replies use the standard
  **24-hour** window. The Human Agent feature allows human support within seven
  days; this automated experiment does not request or use it.
- Standard Access is for development/app roles and professional accounts the
  developer owns/manages or has added in the dashboard. Some functionality can
  remain limited until Advanced Access is granted.
- Meta's webhook guide requires apps to be **Live** to receive notifications.
  Retain the tester/access restrictions for this controlled experiment; switching
  app mode does not establish ordinary-user eligibility.
- Serving professional accounts not owned/managed by the developer, and app
  users without app/business roles, requires Advanced Access, App Review, and
  Business Verification according to the platform overview. A Live app toggle
  alone does not establish ordinary-user eligibility. Before beta, confirm the
  actual account, sender eligibility, app mode, access level, required review,
  privacy policy, and data-deletion requirements in the current dashboard, and
  repeat the test with a permitted ordinary participant. That remains unproven.

## Verification and redacted live evidence

Automated tests exercise challenge responses, authentication (including changed
bytes and Unicode), malformed events, batches, routing, echoes, duplicates and
overlapping deliveries, cache capacity/expiry, and the API adapter over local
HTTP with synthetic credentials. `npm run check` is the complete local gate.

For the real-account smoke test:

1. Record Meta's successful **Verify and save** result and confirm `messages`
   subscriptions at both app and account level.
2. Send a new ordinary text DM from the eligible sender, then check the fixed
   reply in the same Instagram conversation. A dashboard test notification
   alone is not a real-account smoke test.
3. Record UTC time, app mode/access level, token source (never value), and sender
   eligibility. Record a redacted received event with synthetic sender/account/
   message IDs and replaced text; label it as derived from the live delivery.
   Do not persist raw private message bodies. Use Meta's private webhook delivery
   inspector if available to inspect the delivery, then manually redact it.
4. Record the successful outbound response using redacted `recipient_id` and
   `message_id`, plus confirmation that the reply was visible in Instagram.
   Logs alone do not capture these fields or prove recipient delivery.
5. Re-deliver the same authorized event during the same process lifetime, if
   the dashboard supports it; otherwise replay privately with its exact bytes
   and a recomputed signature. Expect duplicate count 1 and no additional reply.

| Evidence                                           | Result                                                        |
| -------------------------------------------------- | ------------------------------------------------------------- |
| Meta HTTPS challenge verification                  | Pending                                                       |
| Real eligible sender and app/account subscriptions | Pending                                                       |
| Redacted real received event                       | Pending                                                       |
| Successful real API reply and inbox confirmation   | Pending                                                       |
| Live duplicate suppression                         | Pending; synthetic automation verifies process-local handling |
| Ordinary-user beta access                          | Unproven; not established by a tester experiment              |

## Official sources

- [Platform overview: accounts, messaging windows, and access levels](https://developers.facebook.com/documentation/instagram-platform/overview)
- [Instagram Login setup and dashboard tokens](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started)
- [Messaging API: permissions, roles, and send endpoint](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api)
- [Webhook verification and signatures](https://developers.facebook.com/documentation/instagram-platform/webhooks)
- [Webhook message examples](https://developers.facebook.com/documentation/instagram-platform/webhooks/examples)
- [Business Login and token lifecycle](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
- [Token refresh reference](https://developers.facebook.com/documentation/instagram-platform/reference/refresh_access_token)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
