import { resolvePackagePath } from '@backstage/backend-plugin-api';
import type { DatabaseService } from '@backstage/backend-plugin-api';
import { TestDatabases } from '@backstage/backend-test-utils';
import type { Knex } from 'knex';
import { applyDatabaseMigrations } from './migrations';

/**
 * Both dialects the plugin supports, and `describe.each` over whichever of them
 * this environment can actually reach — with no `it.skip` anywhere, because a
 * migration is the one piece of code whose entire job is to be correct against
 * a specific dialect's DDL and a silently skipped dialect proves nothing.
 *
 * `disableDocker` is deliberate and is NOT the default here. Left off,
 * `TestDatabases` falls back to `isDockerDisabledForTests()`, which is
 * `!process.env.CI` — and this repo's own test command is `CI=true yarn test`,
 * so the heuristic reads every local run as CI and tries to pull a postgres
 * container on a laptop that may have no container runtime at all. Pinned on,
 * postgres is selected by exactly one thing:
 * `BACKSTAGE_TEST_DATABASE_POSTGRES17_CONNECTION_STRING` pointing at a real
 * server. SQLite has no docker image and so always runs.
 */
const databases = TestDatabases.create({
  ids: ['SQLITE_3', 'POSTGRES_17'],
  disableDocker: true
});

/** A `DatabaseService` over one test connection, which is all the migration
 *  runner reads from the service. */
function service(knex: Knex, skip?: boolean): DatabaseService {
  return {
    getClient: async () => knex,
    ...(skip === undefined ? {} : { migrations: { skip } })
  };
}

/**
 * Index introspection has no cross-dialect spelling — knex offers none — so
 * this asks each catalog directly rather than asserting on something weaker
 * like "the query planner was fast".
 */
async function hasCollectionRefIndex(knex: Knex): Promise<boolean> {
  if (knex.client.config.client.includes('sqlite')) {
    const rows = await knex('sqlite_master')
      .where({ type: 'index', tbl_name: 'bruno_runtime_links' })
      .select('name');
    return rows.some((row: { name: string }) =>
      row.name.includes('collection_ref'));
  }
  const rows = await knex('pg_indexes')
    .where({ tablename: 'bruno_runtime_links' })
    .select('indexdef');
  return rows.some((row: { indexdef: string }) =>
    /\(\s*collection_ref\s*\)/.test(row.indexdef));
}

/**
 * The table shape the pre-migration stores created on boot, reproduced
 * verbatim from the DDL that used to live in `uiCollectionStore.ts` and
 * `runtimeLinkStore.ts`.
 *
 * Copied rather than imported on purpose: this is a FROZEN historical artefact,
 * the exact schema sitting in every database that ran the plugin before
 * migrations existed. If it ever drifts to track the migration, the adoption
 * test below stops testing adoption and starts testing nothing.
 *
 * `withTitle: false` reproduces the even older shape, from before `title` was
 * added — the databases the old store's add-column-if-missing stanza existed
 * for, and the only thing that reaches the migration's `alterTable` branch.
 */
async function createLegacyTables(
  knex: Knex,
  options?: { withTitle?: boolean }
): Promise<void> {
  await knex.schema.createTable('bruno_ui_collections', (table) => {
    table.text('name').primary();
    if (options?.withTitle ?? true) {
      table.text('title');
    }
    table.text('url').notNullable();
    table.text('owner');
    table.text('part_of').notNullable();
    table.text('created_by').notNullable();
    table.text('created_at').notNullable();
  });
  await knex.schema.createTable('bruno_runtime_links', (table) => {
    table.text('collection_ref').notNullable();
    table.text('api_ref').notNullable();
    table.text('created_by').notNullable();
    table.text('created_at').notNullable();
    table.primary(['collection_ref', 'api_ref']);
    table.index(['collection_ref']);
  });
}

const COLLECTION = {
  name: 'payments',
  title: 'Payments',
  url: 'https://github.com/acme/payments/tree/main/collection',
  owner: 'group:default/team',
  part_of: '["api:default/orders"]',
  created_by: 'user:default/a',
  created_at: '2026-01-01T00:00:00.000Z'
};

const LINK = {
  collection_ref: 'bruno:default/payments',
  api_ref: 'api:default/orders',
  created_by: 'user:default/a',
  created_at: '2026-01-01T00:00:00.000Z'
};

describe.each(databases.eachSupportedId())(
  'applyDatabaseMigrations, %p',
  (databaseId) => {
    let knex: Knex;

    beforeEach(async () => {
      knex = await databases.init(databaseId);
    });

    it('creates every table and the collection_ref index on a fresh database',
      async () => {
        await applyDatabaseMigrations(service(knex));

        await expect(knex.schema.hasTable('bruno_ui_collections'))
          .resolves.toBe(true);
        await expect(knex.schema.hasTable('bruno_runtime_links'))
          .resolves.toBe(true);
        await expect(knex.schema.hasTable('bruno_sweep_report'))
          .resolves.toBe(true);
        await expect(knex.schema.hasColumn('bruno_ui_collections', 'title'))
          .resolves.toBe(true);
        await expect(hasCollectionRefIndex(knex)).resolves.toBe(true);
      });

    it('is idempotent when run twice', async () => {
      await applyDatabaseMigrations(service(knex));
      await knex('bruno_ui_collections').insert(COLLECTION);

      await expect(applyDatabaseMigrations(service(knex))).resolves
        .toBeUndefined();

      await expect(knex('bruno_ui_collections').select('*'))
        .resolves.toHaveLength(1);
    });

    /**
     * The entire reason the baseline is guarded rather than a plain
     * `createTable`. Every database that ran the plugin before this migration
     * existed already has these tables, and `knex_migrations` has no record of
     * them — so the first migration runs against a schema it is about to
     * recreate. An unguarded baseline would crash here, and a "fix" that
     * dropped the tables first would take the user's collections with it.
     *
     * Only the BASELINE's two tables are seeded: nothing predates
     * `bruno_sweep_report`, which is why its own migration needs no guards.
     */
    it('adopts tables created by the pre-migration DDL without losing rows',
      async () => {
        await createLegacyTables(knex);
        await knex('bruno_ui_collections').insert(COLLECTION);
        await knex('bruno_runtime_links').insert(LINK);

        await applyDatabaseMigrations(service(knex));

        await expect(knex('bruno_ui_collections').select('*'))
          .resolves.toEqual([COLLECTION]);
        await expect(knex('bruno_runtime_links').select('*'))
          .resolves.toEqual([LINK]);
      });

    it('widens a pre-title table instead of failing on it', async () => {
      await createLegacyTables(knex, { withTitle: false });
      const { title: _title, ...untitled } = COLLECTION;
      await knex('bruno_ui_collections').insert(untitled);

      await applyDatabaseMigrations(service(knex));

      await expect(knex.schema.hasColumn('bruno_ui_collections', 'title'))
        .resolves.toBe(true);
      await expect(knex('bruno_ui_collections').select('*'))
        .resolves.toEqual([{ ...untitled, title: null }]);
    });

    /**
     * `rollback` takes no state from `migrate.latest`, so it needs the
     * directory handed to it again — and resolving it here the same way the
     * runner does doubles as a check that `resolvePackagePath` really does find
     * `migrations/` at the package root from inside `src/`.
     *
     * `rollback(…, true)` rather than `migrate.down`, which unwinds ONE step:
     * with more than one migration in the directory that would leave the
     * baseline's tables standing and the assertions below would be about a
     * rollback that never reached them. `true` is knex's all-the-way flag, so
     * this stays a whole-schema round trip however many migrations land later.
     */
    it('rolls back and forward again', async () => {
      const directory = resolvePackagePath(
        '@usebruno/bruno-backend-plugin-poc',
        'migrations'
      );
      await applyDatabaseMigrations(service(knex));

      await knex.migrate.rollback({ directory }, true);
      await expect(knex.schema.hasTable('bruno_ui_collections'))
        .resolves.toBe(false);
      await expect(knex.schema.hasTable('bruno_runtime_links'))
        .resolves.toBe(false);
      await expect(knex.schema.hasTable('bruno_sweep_report'))
        .resolves.toBe(false);

      await applyDatabaseMigrations(service(knex));
      await expect(knex.schema.hasTable('bruno_ui_collections'))
        .resolves.toBe(true);
      await expect(knex.schema.hasTable('bruno_runtime_links'))
        .resolves.toBe(true);
      await expect(knex.schema.hasTable('bruno_sweep_report'))
        .resolves.toBe(true);
    });

    /**
     * `migrations.skip` is how an adopter points the backend at a read-only
     * replica, or runs migrations out of band as a release step. Asserting on
     * `knex_migrations` as well as on the tables is the point: skipping must
     * write NOTHING, not merely leave the plugin's own tables alone.
     */
    it('writes nothing at all when migrations.skip is set', async () => {
      await applyDatabaseMigrations(service(knex, true));

      await expect(knex.schema.hasTable('bruno_ui_collections'))
        .resolves.toBe(false);
      await expect(knex.schema.hasTable('bruno_runtime_links'))
        .resolves.toBe(false);
      await expect(knex.schema.hasTable('bruno_sweep_report'))
        .resolves.toBe(false);
      await expect(knex.schema.hasTable('knex_migrations'))
        .resolves.toBe(false);
    });
  }
);
