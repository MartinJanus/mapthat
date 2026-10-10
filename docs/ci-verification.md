# CI verification for issue #2

## Required demonstration

Use a draft PR against `main` to prove the workflow on GitHub, not only locally:

1. Push the workflow, templates, and documentation, then open the draft PR.
2. Temporarily change the health response test's expected status from `200` to
   `503`. Commit and push that deliberately failing assertion.
3. Confirm `CI / Verify` fails in the test step. Record the commit and run URL;
   earlier formatting, lint, and type checks should pass.
4. Restore the expected status to `200`, commit, and push.
5. Confirm every CI step passes on the corrected commit. Record the successful
   run URL, then mark the PR ready for review.

Keep the deliberate failure in the draft's verification history; the final source
must contain the correct assertion. A failed job prevents a successful workflow
result. Requiring that result before merge is a separate GitHub ruleset setting,
as described in [Contributing](../CONTRIBUTING.md).

## Evidence record

Local verification on 2026-10-10 with Node 24.21.0:

- `npm run check`: formatting, lint, TypeScript, the health response test, and
  production build passed.
- `actionlint` 1.7.12 against `.github/workflows/ci.yaml`: passed.
- The checkout and setup-node pins match the publisher's v7.0.1 and v7.1.0 tags.

These local results validate the proposed files; GitHub execution remains pending.

| Evidence                                    | State                    |
| ------------------------------------------- | ------------------------ |
| Draft PR                                    | Pending creation         |
| Deliberately failing commit and Actions run | Pending GitHub execution |
| Corrected commit and passing Actions run    | Pending GitHub execution |

Replace the pending entries with links and observed results after executing the
demonstration. Local checks alone do not complete this acceptance requirement.
