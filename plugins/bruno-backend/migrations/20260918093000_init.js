// @ts-check

/**
 * The baseline schema, and the AUTHORITATIVE definition of both Bruno tables.
 *
 * DO NOT "tidy" the `hasTable`/`hasColumn` guards below into plain
 * `createTable` calls. They are not defensive habit, they are the entire
 * reason this migration can exist at all.
 *
 * Before migrations, `uiCollectionStore` and `runtimeLinkStore` each created
 * their own table on boot with guarded DDL, and `title` was added later by an
 * add-column-if-missing. `knex_migrations` has no record of any of that, so on
 * every database that ran the old code this migration is handed tables that
 * already exist with exactly the shape it is about to create. A pure
 * `createTable` baseline would therefore crash every existing deployment on
 * the first boot after upgrading, and the only ways out of that are asking an
 * operator to hand-seed `knex_migrations` against a production database, or
 * declaring a hard reset that destroys every UI-created collection and every
 * runtime link. Both are worse than the guards.
 *
 * The ugliness is contained: it lives in this one file, it was written once,
 * and no migration after this one needs it — #2 onwards run against databases
 * whose state `knex_migrations` genuinely knows.
 *
 * `part_of` is `text` holding JSON, and it must stay `text`. `table.json()`
 * maps to a NATIVE `json` column on postgres, where `node-postgres` parses the
 * value to a JS object on read, and to `text` on sqlite, where it comes back a
 * string. `text` is the only column type whose read-back value is
 * byte-identical on better-sqlite3 and on postgres, and that identity is what
 * lets `parsePartOf` in `store/uiCollectionStore.ts` be one code path instead
 * of a `typeof === 'string'` fork that can only ever be exercised on one
 * dialect at a time. The same reasoning covers every other `text` column here,
 * including the two entity refs on the link table.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('bruno_ui_collections'))) {
    await knex.schema.createTable('bruno_ui_collections', (table) => {
      table.comment('Collections added from the Bruno dashboard');

      table.text('name').primary().comment('metadata.name of the Bruno entity');
      // Nullable, and never `notNullable().defaultTo('')`: the difference
      // between NULL and `''` is the difference between "follow the collection
      // manifest" and "display nothing", and a default would silently pick the
      // wrong one of those for every row.
      table.text('title').comment('Authored metadata.title, or NULL for none');
      table.text('url').notNullable().comment('Normalized collection folder URL');
      table.text('owner').comment('Entity ref of the owner, when one was given');
      table.text('part_of').notNullable().comment('JSON array of entity refs');
      table.text('created_by').notNullable().comment('Entity ref of the creator');
      table.text('created_at').notNullable().comment('ISO 8601 creation time');
    });
  } else if (!(await knex.schema.hasColumn('bruno_ui_collections', 'title'))) {
    // Only reachable on a database created by the pre-migration DDL BEFORE
    // `title` was added to it, which the old store widened on every boot.
    await knex.schema.alterTable('bruno_ui_collections', (table) => {
      table.text('title');
    });
  }

  if (!(await knex.schema.hasTable('bruno_runtime_links'))) {
    await knex.schema.createTable('bruno_runtime_links', (table) => {
      table.comment('Collection-to-API links made in this instance, not in SCM');

      table.text('collection_ref').notNullable().comment('Canonical Bruno ref');
      table.text('api_ref').notNullable().comment('Canonical API entity ref');
      table.text('created_by').notNullable().comment('Entity ref of the creator');
      table.text('created_at').notNullable().comment('ISO 8601 creation time');

      // The pair IS the integrity model: a link either exists or it does not,
      // there is nothing to update, and a second insert is a conflict.
      table.primary(['collection_ref', 'api_ref']);
      // The processor reads the whole table and groups by collection, but the
      // routes look one collection up at a time, and `deleteForCollection`
      // runs on every UI-collection delete.
      table.index(['collection_ref']);
    });
  }
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('bruno_runtime_links');
  await knex.schema.dropTable('bruno_ui_collections');
};
