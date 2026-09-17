# CI

Before this, nothing in the repo was checked automatically — no `.github/`, no
hooks. (The `lint-staged` block in the root `package.json` is inert: husky is
not installed, so nothing invokes it.)

Two workflows now exist.

## `.github/workflows/ci.yml` — the PR gate

Runs on every `pull_request` and on `push` to `main`. Superseded runs for the
same ref are cancelled. Four jobs run in parallel so a failure names itself.

| Job | Command | What a green tick proves | Reproduce locally |
| --- | --- | --- | --- |
| `lint` | `yarn lint` | The hand-written plugin code obeys `eslint.config.mjs` — including the `@stylistic` formatting rules, the hardcoded-colour ban and `import/no-extraneous-dependencies` — with no new warnings. | same command |
| `typecheck` | `yarn tsc` | Both plugins and both app packages compile against the pinned `@backstage/*` versions. | `yarn tsc` |
| `test` | `yarn test --watchAll=false` (`CI=true`) | The Jest suites pass — 113 tests across 12 suites at the time of writing. | `CI=true yarn test --watchAll=false` |
| `e2e` | `yarn test:e2e` against a booted backend | The app bundle builds, the backend boots with no secrets configured, serves the SPA, and the app renders far enough to sign in as guest and show the sidebar. | see below |

Every job installs with `yarn install --immutable`, so a `yarn.lock` that has
drifted from `package.json` fails the build instead of being quietly rewritten.

### Reproducing `e2e`

Under `CI`, `playwright.config.ts` sets `webServer: []` and points `baseURL` at
`http://localhost:7007`. Nothing starts itself — the tests talk to the backend,
and the backend serves the frontend through `plugin-app-backend`. So:

```sh
yarn workspace @usebruno/backstage-frontend build   # required: backend serves packages/app/dist
yarn workspace @usebruno/backstage-backend start &  # boots on :7007
curl -fsS http://localhost:7007/api/bruno/health    # poll until this answers
npx playwright install --with-deps chrome           # channel is 'chrome', not chromium
CI=true yarn test:e2e
```

Three things are easy to get wrong here:

- **`yarn build:backend` does not work.** The root script runs
  `yarn workspace backend build`, but the workspace is named
  `@usebruno/backstage-backend`. Use the real name, as the workflow does.
- **Build the app, not just the backend.** `packages/backend` builds a
  deployable tarball; it does not build `packages/app/dist`, which is what
  actually gets served at `/`.
- **Probe `/api/bruno/health`, not `/healthcheck`.** There is no `/healthcheck`
  route: the app-backend SPA fallback answers it with `index.html` and a 200,
  so it would report "ready" for any path at all. `/api/bruno/health` is
  registered `allow: 'unauthenticated'` in
  `plugins/bruno-backend/src/plugin.ts` and returns `{"status":"ok"}`.

No secrets are needed. Backstage drops config values whose `${VAR}` is unset,
so the unset `GITHUB_TOKEN` / `AUTH_*` / `BITBUCKET_*` variables simply remove
those keys and the backend starts cleanly. The catalog's `type: url` locations
will fail to fetch unauthenticated, which is logged and does not affect the
test.

### The lint warning budget

`--max-warnings 5` pins today's count rather than allowing warnings in general.
All five are `@typescript-eslint/no-explicit-any`, in two ambient module shims:

- `plugins/bruno-backend/src/types/usebruno-lang.d.ts`
- `plugins/bruno-backend/src/types/usebruno-converters.d.ts`

Both declare `@usebruno/*` packages that ship no types, and both document their
`any`s as intentional boundary types narrowed by the caller. Fixing them is a
typing job, not a lint job. Until someone does it, the ceiling stops a sixth
warning from appearing anywhere — including `react-hooks/exhaustive-deps`,
which is also `warn`. Lower the number when the shims get real types; do not
raise it.

### Not gated, on purpose

- **`packages/app` and `packages/backend` have no lint coverage at all.**
  `yarn lint` and `yarn lint:all` used to call `backstage-cli repo lint`, which
  cannot run here: it constructs ESLint inside a worker thread with
  `new ESLint({ extensions: [...] })`, the worker resolves `eslint` from the
  repo root — `9.39.5`, the version the flat config requires — and ESLint 9
  removed `extensions`, so it exits with
  `Invalid Options: Unknown options: extensions` before linting anything.
  `backstage-cli package lint` fails differently, unable to resolve
  `@spotify/eslint-config-base`. Both scripts now run the flat config over the
  plugin source this repo actually authors, so `yarn lint` works and is what CI
  runs; the two Backstage scaffold packages stay uncovered. Pre-existing, and
  independent of CI.
- **`yarn prettier:check`.** ESLint is the formatter of record here; the
  `@stylistic` rules in `eslint.config.mjs` own formatting.
- **`yarn bruno:catalog:check`.** `scripts/bruno-catalog/generate.mjs` does a
  `git clone --depth 1` per source against `github.com/bruno-collections`.
  Network-dependent and rate-limitable, so it stays off the PR path.

## `.github/workflows/nightly.yml` — the expensive legs

Runs at 03:00 UTC daily, and on demand via `workflow_dispatch`. Neither job is
a merge gate; both mutate the dependency graph before checking anything.

| Job | What it does | Why |
| --- | --- | --- |
| `compat` | Matrix over Backstage `1.53.0` / `1.52.0` / `1.51.0`: `versions:bump --release <v> --skip-install`, `yarn install --no-immutable`, `yarn tsc`. | Establishes the real version floor cheaply. The suspected constraint is the frontend blueprint APIs, and those break at compile time — so `tsc` alone answers it. |
| `drift` | `rm yarn.lock`, `yarn install --no-immutable`, then `yarn tsc` and the tests. | Every `@backstage/*` dependency is a `^` range. A clean install months from now resolves differently than the lockfile pins; this finds that before an adopter does. |

`compat` sets `continue-on-error` per leg: the `1.53.0` leg is real signal
(`backstage.json` already says `1.53.0`, so that bump is near a no-op and
should pass), while `1.52.0` and `1.51.0` are the actual experiment and are
allowed to fail. `drift` is advisory in full — it tests versions nobody has
committed to, so a failure is news rather than a regression.

Note for `drift`: `yarn install --no-immutable` on its own re-uses everything
the existing lockfile already satisfies, which would make the job a duplicate
of `test`. The lockfile has to be deleted for the ranges to re-resolve.

Note for both: `.yarnrc.yml` sets `npmMinimalAgeGate: 3d`. `@backstage/*` is
listed in `npmPreapprovedPackages` and is exempt, but a brand-new transitive
dependency can still be held back by the gate.
