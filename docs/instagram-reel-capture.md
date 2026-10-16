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
score at least 0.8 and lead the runner-up by 0.2. Competing plausible branches can be returned as explicitly labelled possible
matches in the Instagram flow. Non-exact accepted names are shown as **Likely match**; this is a
heuristic, not a calibrated probability or proof of the branch.

Gemini is instructed to apply shared city/country context only when the whole
caption supports it and to preserve per-place locations in multi-city lists.
Supporting quotes must occur in the caption. The extraction cache version is
bumped so earlier results do not suppress this change.

Matched Google Maps buttons use a place ID and coordinates; Apple Maps buttons
use the same coordinates. Cards retain the address and identify Google Maps as
the data source. Up to three photo resources are tried for an accepted place.
Invalid optional photo metadata cannot discard a valid business. The carousel has exactly two visible buttons: Google Maps and Apple Maps.
Separate author/profile text messages are no longer sent. When Google supplies
the photo's `googleMapsUri`, tapping the card/image opens that individual source
photo with its full author attribution. This uses Google's space-limited gallery
attribution option. If only legacy author metadata exists, a single author's full
name is kept compactly in the subtitle and the card tap links to their profile.
If those credits cannot be represented, the verified place remains as a card
without that photo. Photos that cannot be retrieved also yield a card without
an image. Required provider names remain in the card; if they cannot fit,
the result becomes a caption search card.

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

## Caption-first extraction and optional video fallback

Caption evidence tolerates Unicode quote/dash and whitespace differences.
It does not accept paraphrases. Invalid or ungrounded items are removed individually
so a bad sibling does not erase grounded recommendations. Grounded street/district
quotes can narrow same-name branches; destination city/country must still agree
with Google's address components. Missing context stays ambiguous.

The caption cache is versioned as caption-v3. Only caption results are cached.
Video evidence, Google results and photo URLs are not added to the disk cache.
When enabled, fallback can still run after a cached caption result.

Set `INSTAGRAM_VIDEO_FALLBACK_ENABLED=true` only after verifying that your
app is permitted to retrieve and send the received media to Gemini. Default is
false. This implementation does **not** prove that shared-Reel webhook URLs give
your app video access. An Instagram permalink is not a media URL and is never
scraped. A supported direct HTTPS Meta CDN URL in the attachment's `url` is
required. Missing/expired/inaccessible media retains the caption results.

Fallback runs once per processing attempt when the caption has no recommendations,
has only ungrounded output, or leaves unmatched/ambiguous places. Caption provider
or configuration failures and Places outages do not trigger paid video analysis.
Successful caption matches are preserved. Every accepted video venue is matched
against Google Places before it can become a photo card. Gemini's quotes and
timestamps are structured evidence supplied by the model, not independently
verified ground truth; visual appearance alone is excluded.

Downloads allow only explicit Meta CDN hostnames, HTTPS, no credentials, no
redirects, 10 seconds, 12 MiB (including streams without Content-Length), supported
video MIME types and file signatures. Bytes stay in memory and go to Gemini as
inline data. Analysis is limited to the first 180 seconds at 1 FPS; audio is
included by Gemini's video processing. Gemini requests have a 30-second timeout.
Signed media URLs, captions and provider errors are excluded from new diagnostics.
Fallback logs record outcome, category and elapsed time, not billing totals.

This remains a synchronous controlled-test prototype. Move extraction to the
durable queue/worker before production deployment; timeout and retry handling
must be designed there. A real-account test still needs to verify permitted media
access, actual extraction accuracy, delivery timing and Instagram photo fetching.

Smoke test after configuring keys:

1. Send a caption with named places and a shared city: verify venue addresses,
   Google place IDs, Apple coordinates and that photos depict the selected venue.
2. Send two same-name branches, then a caption specifying a street: only the
   street-supported branch should match.
3. With fallback enabled and a permitted direct media URL, send a captionless Reel
   naming a venue in speech/on-screen text. Verify its Google match and photo.
4. Repeat with a permalink/expired URL: grounded caption results must survive.
5. Inspect stage/outcome logs for API failures without exposing keys or media URLs.

Reference: [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding).

## Carousel-only result presentation

Every extracted recommendation stays in the carousel. Ambiguous, not-found,
missing-geography and unavailable matches become explicitly labelled search cards
with the caption's city/country included in the Maps queries. They have no
invented coordinates, place ID or unrelated photo. Strong contextual matches
continue to show the selected venue and photo; approximate accepted names retain
the Likely match label. The minimum name score and geography/address checks are unchanged. When several
plausible candidates are close, the best-ranked candidate can now appear as a
Possible match instead of an unresolved search card.

The normal response is the progress message followed by one carousel per ten
locations, with only Google Maps and Apple Maps buttons. Credits do not create
separate URL-preview bubbles. Text fallback remains for failed template delivery.
Real-account verification should check both map buttons, horizontal scrolling,
and the photo/card tap opening the credited source on Google Maps.

References:

- [Google photo attribution and space-limited galleries](https://developers.google.com/maps/documentation/places/web-service/policies#photos_and_reviews)
- [Google photo source URL](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places#Photo)
- [Meta generic template default action](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)

## Possible matches with photos

The Instagram matcher permits a suggestion when the best geographically compatible
candidate meets the existing 0.8 name threshold but does not beat the runner-up by
0.2. It keeps the best name score, preserving Google's returned order for tied
scores. This is a heuristic suggestion, not a calibrated confidence probability.
The strict `selectPlaceMatch` default is retained for callers that do not opt in.

These cards say **Google Maps · Possible match · Check address** before the
address. Their photo, place ID, Google Maps link and Apple Maps coordinates all
belong to that one selected candidate. Photos are loaded after selection; photo
availability never chooses the branch. If no photo can load, the warning and both
links remain. Existing photo attribution/source navigation is preserved.

Contradictory city/country or an explicit address hint is never discarded to make
a guess. Weak names and missing geography still yield search cards. Strong,
distinct matches retain their previous confidence labels.

A possible caption match remains eligible for optional video refinement. Video
can replace it with a better-supported match (including the same Google place
ID); a failed video request leaves the possible card intact. Confirmed caption
matches remain protected from replacement.
