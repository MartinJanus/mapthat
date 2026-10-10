# MapThat

MapThat will turn places mentioned in Instagram videos into map results. This
repository currently provides the Next.js App Router foundation with strict
TypeScript, a minimal homepage, and a health endpoint.

## Requirements

- Node.js **24.21.0**, recorded in `.nvmrc`.
- npm, included with Node.js. Use the committed `package-lock.json` with `npm ci`.
- Git. For Windows development, run the commands inside WSL2 with a Linux
  distribution such as Ubuntu, using Node installed inside WSL.

The commands below assume [nvm](https://github.com/nvm-sh/nvm#installing-and-updating)
is installed in your Linux shell. Another Node version manager is fine if it
selects the version in `.nvmrc`. Keep the checkout in the WSL Linux filesystem
(for example, under `~/repos`) for faster file watching and installs.

## Setup and development

From a fresh checkout:

```bash
git clone https://github.com/MartinJanus/mapthat.git
cd mapthat
nvm install
nvm use
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Edit the
homepage in `src/app/page.tsx`; the development server updates it automatically.
To use another port, run `npm run dev -- --port 3001`.

No environment variables or Meta, Google, or AI credentials are required.
`.env.example` intentionally contains only comments. Copying it to `.env.local`
is optional. When a feature introduces configuration, document placeholder
values in `.env.example` and validate them when that feature needs them. Keep
real credentials in ignored local environment files; never commit them or expose
them through public responses.

## Commands

| Command                | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `npm run dev`          | Start the development server                                |
| `npm run typecheck`    | Check strict TypeScript without emitting files              |
| `npm run lint`         | Run ESLint; warnings fail the check                         |
| `npm run format:check` | Check formatting without modifying files                    |
| `npm run format`       | Apply Prettier formatting                                   |
| `npm test`             | Run the tests once                                          |
| `npm run test:watch`   | Run tests in watch mode                                     |
| `npm run build`        | Create a production build                                   |
| `npm start`            | Serve the existing production build                         |
| `npm run check`        | Run formatting, lint, type, test, and build checks in order |

## Verification

After `npm ci`, run the complete check:

```bash
npm run check
npm start
```

With the production server running, open the homepage and run this in a second
terminal:

```bash
curl -i http://localhost:3000/api/health
```

Expect HTTP **200**, `Content-Type: application/json`,
`Cache-Control: no-store`, and the body `{"status":"ok"}`. The response is a
liveness check, with no secrets or internal configuration. It does not check
external providers. Unsupported methods such as `POST` return HTTP **405**.
Stop the server with Ctrl+C.

The Vitest test in `src/app/api/health/route.test.ts` calls the real route handler
and verifies its HTTP response status, headers, and exact JSON body. It needs no
running server, paid services, or live credentials. The curl check additionally
verifies routing through a running Next.js server.

## Application structure

- `src/app/page.tsx`: minimal homepage.
- `src/app/layout.tsx` and `src/app/globals.css`: shared layout and global styles.
- `src/app/api/health/route.ts`: health HTTP handler.
- `src/**/*.test.ts`: tests discovered by Vitest.

As product behavior appears, put reusable application logic in feature modules
outside page components and HTTP handlers. Those entry points should call that
logic so the Instagram bot, discovery pages, and extraction API can reuse it.
Introduce modules when there is behavior to own rather than creating empty
service layers now.

Provider integrations, databases, background jobs, production deployment,
discovery rankings, and paid API access are outside this foundation issue.

## Project workflow and scope

- [Prototype scope and feasibility questions](docs/scope.md)
- [Contribution workflow, action pinning, and secrets](CONTRIBUTING.md)
- [Architecture-decision template](docs/decisions/template.md)
- [CI verification record](docs/ci-verification.md)
