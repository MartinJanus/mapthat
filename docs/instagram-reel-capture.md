# Instagram Reel capture

When someone sends MapThat an Instagram Reel, the verified webhook stores the
full webhook entry as local JSON. This is for inspecting what the official
Instagram webhook provides before building location extraction.

## Use it

1. Start MapThat with its normal Instagram webhook configuration.
2. Expose the local webhook over HTTPS and set that URL in Meta while testing.
3. Send any Reel to the MapThat Instagram account.
4. Run `npm run experiment:results`.

Each capture is written as a separate file in the ignored
`.local/instagram-reels/` directory and printed in full by the command.

When `GEMINI_API_KEY` is configured, a Reel with a nonempty caption receives
an eyes reaction on the incoming message and `Finding your locations…`, followed
by place cards where the caption provides enough city or country context. A
failed reaction does not stop processing. Each card has Google Maps and Apple
Maps buttons. One place produces one card; multiple places produce a carousel,
split into messages of at most 10 cards. A place without geographic context is
reported as ambiguous. Ordinary text messages keep the existing connectivity
reply.

Without `GOOGLE_PLACES_API_KEY`, cards are labelled **Caption candidate (not
verified)** and contain search links. To enable matching and images, enable
**Places API (New)** in a Google Cloud project with billing, configure its
server-side API key in ignored `.env.local`, and restart MapThat. The adapter
uses Text Search (New) with explicit fields and requests at most 20 candidates
per mention. Each request has a five-second timeout, no retries, and a response
size limit. Ordinary tests use local HTTP fixtures and never need a live key.

Matching requires supplied geography to agree with address components, including
Hong Kong country-style components and HK/SAR aliases. Names use normalized token
overlap, distinctive name tokens after removing business descriptors, and compact
handle comparison. Contextual destination suffixes such as `hk` are removed from
compact handles when the caption identifies that destination. A candidate must
score at least 0.8 and lead the runner-up by 0.2. Competing branches remain
ambiguous. Non-exact accepted names are shown as **Likely match**; this is a
heuristic, not a calibrated probability or proof of the branch.

Gemini is instructed to apply shared city/country context only when the whole
caption supports it and to preserve per-place locations in multi-city lists.
Supporting quotes must occur in the caption. The extraction cache version is
bumped so earlier results do not suppress this change.

Matched Google Maps buttons use a place ID and coordinates; Apple Maps buttons
use the same coordinates. Cards retain the address and identify Google Maps as
the data source. Up to three photo resources are tried for an accepted place.
Invalid optional photo metadata cannot discard a valid business. Every author
is credited in full in text before the card; a third button links to a single author when their name fits. Multiple or long
author names are credited in the preceding text without adding extra buttons.
Multiple authors and long names no longer cause photos to be omitted. Photos
that cannot be retrieved still yield a card without an image.

API keys are sent in headers and never included in cards. Place search results
and photo names are not cached or written to Reel captures. Server diagnostics
record stage, HTTP status, timeout/response failure category, or invalid field
paths. They omit keys, request URLs, response values, and caption contents.

If Meta cannot send a card, MapThat sends the place details and both Maps links
as text instead. Text is split at the 1,000-byte boundary, preserving complete
link lines. Oversized caption search queries are shortened to keep each link
within that limit. A transport timeout or malformed success response is an
uncertain delivery: the fallback may accompany a card that Meta actually
accepted. Failed sends are not retried automatically, and redelivery of the
incoming event does not repeat the reaction, matching, cards, or fallback during
the same process lifetime.

The capture only runs after Meta's HMAC signature has been verified. It stores
the webhook content unchanged, including the Reel attachment payload and its
caption when Meta supplies one. App configuration values, such as the access
token and app secret, are not webhook content and are never written to captures.
The current prototype processes Gemini, Places, photos, and replies during the
webhook request; it is for controlled testing, not production hosting. Matching
confidence, live reaction support, card rendering, and photo accessibility still
need a real-account smoke test. Process-local deduplication is lost on restart.

Provider references checked for this implementation:

- [Meta message reactions](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api)
- [Meta generic templates and limits](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/generic-template)
- [Google Text Search (New)](https://developers.google.com/maps/documentation/places/web-service/text-search)
- [Google Place Photos (New)](https://developers.google.com/maps/documentation/places/web-service/place-photos)
- [Google Places attributions](https://developers.google.com/maps/documentation/places/web-service/policies)
