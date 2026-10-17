# Supabase request tracking

Project: [map-that](https://supabase.com/dashboard/project/canxffpupcoppqvbmdyy).

## Enable the integration

The hosted schema is already applied. The files under `supabase/migrations/`
use the actual versions recorded by that project's migration history. The local
runtime was unavailable during setup, so the migrations were applied with the
Supabase connector and verified with live SQL instead of the local CLI.

Add these settings privately to ignored `.env.local` and later to your server's
environment:

```dotenv
SUPABASE_URL=https://canxffpupcoppqvbmdyy.supabase.co
SUPABASE_SECRET_KEY=your_secret_key
TRACKING_HASH_SECRET=your_stable_random_secret
```

Create/copy a modern `sb_secret_...` key in
[Settings > API Keys](https://supabase.com/dashboard/project/canxffpupcoppqvbmdyy/settings/api-keys).
Do not paste it into chat, commit it, or use a `NEXT_PUBLIC_` variable.
Generate the separate hashing secret with a password manager (at least 32 random
characters). Keep it stable: changing it changes user identities and deduplication
keys. Use a different secret and project for test/staging environments.

Pull this PR's branch, install with `npm ci`, run `npm run check`, then rebuild
before restarting a production server. All three settings absent preserves the
existing prototype behavior. Partial configuration fails closed when a Reel is
received. Database claim failures return HTTP 503 before replies or paid work.

## What is saved

- `extraction_requests`: one durable claim per account/message, pseudonymous user
  and Reel identities, terminal status, runtime and reply counts.
- `places`: Google Place IDs only. Provider addresses, coordinates, names,
  photo URLs and attributions are not copied into the database.
- `request_places`: the final extracted mention names and caption/video city and
  country, selected Place IDs, confidence and whether a photo was fetched.
  Evidence quotes are omitted. These rows record extracted candidates, not proof
  that the user visited or endorsed the place.
- `provider_usage`: each attempted Gemini caption/video and Google search/photo
  request, duration, HTTP status when known, and Gemini token metadata when returned.
  Missing metadata stays null; it is not treated as free usage.
- `request_events`: up to 200 allowlisted diagnostic events per request. No raw
  message payloads, captions, media URLs, tokens or arbitrary diagnostic fields.

Google Places content remains request-local. Load fresh provider details with the
proper attribution when building a later discovery site. Do not turn the Place ID
table into a permanent copy of Google listings or photos.

Existing local caption caching and opt-in raw-webhook experiment capture are
separate from this database integration. This change does not migrate or delete
their files. Review those experiment settings before production deployment.

## Inspect usage now

Open Supabase's Table Editor for recent requests, result rows and usage. In the
SQL Editor, run:

```sql
select * from public.request_metrics_daily order by day desc;
select * from public.provider_metrics_daily order by day desc;
select * from public.place_popularity order by unique_users desc limit 20;
```

Requests are classified as:

- `completed`: extracted locations all have high-confidence matches, with no
  failed result delivery.
- `partial`: locations include uncertain/unmatched candidates or some replies failed.
- `no_places`: extraction returned no recommendations.
- `failed`: extraction/provider failure, unexpected exception or failed initial reply.
- `unsupported`: an unsupported-media reply was handled.
- `processing`: claimed but not finalized.

Reply counts include the progress reply; failed carousel attempts also remain
visible if a text fallback succeeds. Photo availability means a photo was fetched,
not necessarily displayed by Instagram. Provider success means the HTTP/SDK call
succeeded, not that extraction or location matching was accurate.

Popularity counts high-confidence results from completed/partial requests only.
It uses distinct users and distinct stable Reel identities, excluding uncertain
guesses. A repeated message is not a new extraction. User counts are scoped to
the receiving Instagram account. Missing stable Reel identities remain null.

These are reporting views, not a finished web dashboard. Dollar amounts are not
yet calculated: usage must be priced against the applicable model/SKU and billing
tier, then reconciled with actual provider billing. Failed calls are attempts, not
necessarily billed calls.

## Security and reliability boundaries

Every table has RLS and backend-only grants/policies. The completion function is
`SECURITY INVOKER`, executable only by `service_role`. Views use
`security_invoker = true` and are backend-only. No public or signed-in user can
read another user's request data. The Next.js server uses the REST API with a
server-only key; no browser Supabase client or new package is needed.

The unique database claim prevents processing the same incoming message across
restarts or concurrent server instances. Completion writes results, usage, events
and status in one transaction and is idempotent.

This is not yet a durable job queue. If the process dies after claiming, or cannot
save completion after sending, the row can remain `processing`. Redelivery does
not automatically re-run claimed requests, to avoid duplicate replies and charges.
Investigate stale rows instead of blindly deleting/replaying them. A completion
outage returns 503 and emits `instagram.persistence_failed`; the existing claim
still prevents a second extraction. Usage from a process crash cannot be recovered
by this phase. Add queued jobs, leases and explicit retry/delivery handling next.

There is no automatic retention or user-deletion workflow yet. Keep the beta
small; define retention and deletion before opening access broadly. To delete a
user's request history, use their keyed `sender_ref` in an authorized admin
workflow; request results, usage and events cascade with the request.
