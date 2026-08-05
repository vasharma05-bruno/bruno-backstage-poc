/*
 * Local dev only: load the repo-root `.env` into `process.env` BEFORE the
 * backend reads app-config (which substitutes `${AUTH_GITHUB_CLIENT_ID}`,
 * `${GITHUB_TOKEN}`, etc.). Imported first in `index.ts` so it runs before any
 * config is loaded.
 *
 * A couple of candidate paths are tried so it works regardless of the cwd that
 * `backstage-cli repo start` runs the backend with (repo root vs.
 * `packages/backend`). No-op if no `.env` is found — production hosts supply
 * these via the real environment, not a file.
 */
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

for (const candidate of ['.env', '../../.env']) {
  const path = resolve(process.cwd(), candidate);
  if (existsSync(path)) {
    loadEnv({ path });
    break;
  }
}
