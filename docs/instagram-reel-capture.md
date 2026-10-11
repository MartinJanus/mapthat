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
`Finding your locations…`, followed by a separate message for each place where
the caption provides enough city or country context. Each result contains Google
Maps and Apple Maps search links. A place without that context is reported as
ambiguous. Ordinary text messages keep the existing connectivity reply.

The capture only runs after Meta's HMAC signature has been verified. It stores
the webhook content unchanged, including the Reel attachment payload and its
caption when Meta supplies one. App configuration values, such as the access
token and app secret, are not webhook content and are never written to captures.
The current prototype processes Gemini requests during the webhook request; it
is for controlled testing, not production hosting.
