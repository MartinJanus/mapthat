# Contributing

## Issue to merge

1. Start with an issue describing the goal, observable acceptance criteria,
   verification, dependencies, and exclusions. Use the task, feature, or bug
   template. Check [prototype scope](docs/scope.md) before widening the product.
2. Branch from up-to-date `main` for one issue. Use a descriptive branch name.
   Follow the [README](README.md) to select Node and install from the lockfile.
3. Make one small, reviewable change. Add meaningful tests for behavior and update
   documentation. Record consequential choices using the
   [architecture-decision template](docs/decisions/template.md).
4. Run `npm run check`. Commit the intended files, push the branch, and open a
   small PR against `main`. Link the issue; use `Closes #N` only when its acceptance
   criteria are complete. Explain behavior changes and verification results.
5. Wait for `CI / Verify` on the latest commit and request review. Resolve review
   findings and rerun affected checks. A failed or cancelled CI run is not a pass.
6. Merge after checks pass and review is complete. Do not use administrative
   bypass to treat a failing check as verified. If merge enforcement is needed,
   configure a GitHub ruleset requiring the Verify check and review; the workflow
   file alone does not prevent merges.

## CI and action pinning

`.github/workflows/ci.yaml` runs on PRs targeting `main` and pushes to `main`.
It reads Node from `.nvmrc`, runs `npm ci`, and checks formatting, lint,
TypeScript, tests, and the production build. It needs no Meta, Google, or AI
credentials. Its token has only `contents: read`; checkout does not persist Git
credentials. Do not grant write permissions without a concrete workflow need.

Pin every `uses:` action to a full 40-character commit SHA, with its release tag
in a comment. Verify the SHA against the action publisher's release tag before
updating it. Update pins in a small PR that records the release and reason, then
run the full CI suite. Do not replace immutable pins with moving major-version
tags. Keep `.nvmrc` and the README's Node version consistent when updating Node.

See [CI verification](docs/ci-verification.md) for the failing-then-passing PR
demonstration required by issue #2.

## Secrets and evidence

- Ordinary checks use fixtures, not live provider credentials. Run authorized
  provider experiments separately and label their evidence accordingly.
- Keep local credentials in ignored `.env.local` files. `.env.example` contains
  documented placeholders only; validate configuration when its feature needs it.
- Never put credentials in client code, `NEXT_PUBLIC_` variables, response bodies,
  issue text, PR descriptions, logs, screenshots, or test fixtures.
- Redact private messages and personal data from review evidence. Use authorized
  examples and synthetic values for reproducible tests.
- If a secret is exposed, revoke or rotate it promptly and notify the repository
  owner privately. Deleting the visible value does not revoke the credential.
