# Prototype scope

## Goal and included workflow

Prove that an Instagram user can DM a Reel to MapThat and receive Google Maps
and Apple Maps links for identifiable places in that Reel, using permitted
content access. Start with controlled test participants and authorized examples.
Public availability is not yet proven.

The prototype includes DM intake, an acknowledgement (including the proposed
eyes reaction where supported), permitted content retrieval, place extraction,
location matching, and a reply. Record processing duration, provider usage,
and estimated cost for each test run. Retain only the data needed to reproduce
and assess the result; this is not a general analytics platform.

## Unresolved feasibility questions

These are questions to investigate, not capabilities the foundation already has.

| Question                | Evidence needed before treating it as supported                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reel content access     | Current provider documentation and an authorized test showing which DM attachments, media, audio, captions, or links can actually be retrieved; record inaccessible cases and permission requirements.              |
| Follower verification   | Establish whether the permitted API can verify that the sender follows the bot account, with the required account type and permissions. If it cannot, document an alternative eligibility rule before adopting one. |
| Public-user eligibility | Verify which users can message and receive replies, including account types, app review, access levels, reply windows, and restrictions beyond enrolled testers.                                                    |

A successful test with an enrolled participant does not establish public-user
eligibility. If a required capability is unavailable, record the blocker and
revise the supported workflow explicitly rather than assuming another access path.

## Prototype success criteria

Before evaluating extraction, record an authorized fixture set and its expected
places. Include a single place, multiple places, an ambiguous name, no identifiable
place, and inaccessible content. Fix the expected results before running the bot.

The prototype succeeds when:

- An authorized participant completes DM intake through a Maps-link reply for a
  supported Reel, with an acknowledgement and a traceable processing result.
- Every accessible, unambiguous fixture returns the expected places and valid
  Maps links; inspect link destinations against the recorded expected locations.
- Ambiguous, empty, and inaccessible examples receive a clear outcome without
  fabricated locations or links.
- Each run records outcome, processing duration, provider usage, and estimated
  cost. Report the measurements and failures; no latency or cost target is claimed
  until there is evidence to choose one.
- Ordinary automated tests use fixtures and need no paid services or live
  credentials. Separate authorized provider experiments from that test suite.
- The feasibility questions above have recorded evidence, supported boundaries,
  and remaining blockers. Unresolved public access must remain labelled unproven.

## Private-beta requirements

Passing the controlled prototype does not mean the service is ready for a
private beta. Before inviting users, verify:

- Durable jobs, retries, and recovery after a process restart.
- Duplicate-event handling that avoids duplicate work and replies.
- An explicit participant eligibility policy supported by provider capabilities.
- Enforced usage limits and spending controls.
- Privacy, retention, and deletion behavior for messages and extracted data.
- Operational monitoring and user-facing handling of provider failures.

Choose numerical limits and retention periods in later decisions supported by
prototype measurements; this document does not invent those commitments.

## Architecture boundaries

| Layer             | Responsibility                                                                                                                                                                                         | Boundary                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Entrypoints       | Next.js pages and HTTP handlers; later Instagram webhooks and API endpoints. Parse incoming requests, enforce applicable access rules, invoke application logic, and translate results into responses. | Keep extraction, matching, and workflow decisions out of page components and handlers.                                                    |
| Application logic | Coordinate extraction, matching, and reply outcomes using typed inputs and results.                                                                                                                    | Reuse the same behavior across the bot, discovery, and API; avoid depending on HTTP, React, or a provider SDK.                            |
| Provider adapters | Translate permitted Meta content access, AI extraction, and map-provider calls into application contracts.                                                                                             | Own credentials, provider payload parsing, timeouts, and provider-specific failures; validate configuration when that feature is invoked. |

Introduce feature modules and adapters as behavior appears. These are ownership
rules, not a request to create empty directories or interfaces now. The existing
health handler is a simple liveness response and needs no service layer.

## Later direction and exclusions

Later discovery pages may present extracted places and popular locations. A later
extraction API may expose the same processing logic to external clients. Both
should reuse the application layer rather than copying Instagram handlers.

The prototype excludes public discovery rankings, external API customers,
payments, and itinerary planning. Issue #2 also excludes automatic production
deployment, elaborate project boards, and a detailed backlog for future products.

Use the [decision template](decisions/template.md) to record consequential choices
and [the contribution workflow](../CONTRIBUTING.md) for implementation changes.
