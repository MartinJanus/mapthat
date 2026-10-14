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

Matching requires every supplied city/country to match a relevant address
component. The selected name must match exactly after case, punctuation, and
accent normalization. Word order is retained. The selected candidate must also
lead the runner-up by at least 0.2 in token overlap score. Accepted matches are
labelled **high confidence**. This is a local heuristic label, not a probability
supplied by Google or proof of correctness. Photo availability is checked only
after identifying the place; it does not resolve ambiguous branches. Competing
branches, conflicting geography, and weak names produce an ambiguity response.
Empty search results receive a no-match explanation. Provider failures receive
explicitly unverified caption search links in text.

Matched Google Maps buttons use a place ID and coordinates; Apple Maps buttons
use the same coordinates. Cards identify Google Maps as the data source. The
first photo returned for the matched place is resolved server-side to an HTTPS image URL using
`skipHttpRedirect=true`; API keys are sent in headers and never included in
outbound cards. A photo with one short author name receives a third credit button.
Long author names and multiple author credits are sent in full as text before
the card; the first photo is still displayed. If the correct place has no photo,
or its first photo cannot be retrieved, MapThat sends an explanation and Maps
links as text. It does not switch to a different location or a later photo.
Additional place-provider attributions are sent as text before the card.
Place search results and photo names are not cached or
written to Reel captures.

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
