import { resolvePackagePath } from '@backstage/backend-plugin-api';
import type { DatabaseService } from '@backstage/backend-plugin-api';

/**
 * `migrations/` sits at the PACKAGE ROOT, beside `dist/`, and is resolved
 * through `resolvePackagePath` rather than off `__dirname`.
 *
 * That is not a stylistic preference. This module is `src/store/migrations.ts`
 * when the plugin runs from source and `dist/index.cjs.js` when it runs from a
 * published tarball, so any `__dirname`-relative path is wrong in one of those
 * two worlds. `resolvePackagePath` goes through `require.resolve` on the
 * package's own `package.json` and then up one, which lands on the package root
 * identically either way — and `files` in `package.json` must list `migrations`
 * or the directory is simply not in the tarball to be found.
 */
const migrationsDir = resolvePackagePath(
  '@usebruno/bruno-backend-plugin-poc',
  'migrations'
);

/**
 * Brings both Bruno tables up to date, once, before any store is built.
 *
 * Backstage runs NOTHING for a plugin here: `DatabaseManager` hands out a
 * connection and no more, so every plugin migrates its own schema on init.
 * This is called from `plugin.ts` ahead of the two store factories, which
 * afterwards do pure data access and assume the tables are there.
 *
 * The stores used to tolerate a concurrent creator by catching the DDL error
 * and re-checking `hasTable`. Nothing replaces that here because nothing needs
 * to: `migrate.latest` takes `knex_migrations_lock` first, so two replicas
 * starting together serialise rather than race, and the loser sees the work
 * already done instead of an error it has to interpret.
 *
 * The skip flag is the adopter's, not ours — it is how a deployment points the
 * backend at a read-only replica, or runs migrations out of band as a separate
 * release step. Honouring it means a database this process must not write to
 * is one it does not try to write to at boot.
 */
export async function applyDatabaseMigrations(
  database: DatabaseService
): Promise<void> {
  const client = await database.getClient();

  if (database.migrations?.skip) {
    return;
  }

  await client.migrate.latest({ directory: migrationsDir });
}
