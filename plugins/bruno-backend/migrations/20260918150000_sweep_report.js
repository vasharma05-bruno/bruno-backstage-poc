// @ts-check

/**
 * The discovery sweep's report — one row, replaced on every tick.
 *
 * WHY A TABLE AT ALL for something that could be a field on the router. The
 * sweep runs in `brunoCatalogModule` and the route that reports it is in the
 * `bruno` plugin: two separate backend features, no in-process link. And the
 * provider's scheduled task is `scope: 'global'`, so the sweep runs on ONE
 * replica while the route is served from all N — an in-memory field would
 * answer "nothing to report" from every replica but one, at random, for a strip
 * whose entire job is to say when something IS missing. The plugin's database
 * is where its cross-replica state already lives.
 *
 * Unguarded `createTable`, unlike the baseline beside it. That file's
 * `hasTable` stanzas exist because its tables predate migrations and sit in
 * every deployed database with no `knex_migrations` record; this table has
 * never existed anywhere, so #2 onwards run against a schema
 * `knex_migrations` genuinely knows, exactly as the baseline's docblock says.
 *
 * `incomplete` is `text` holding JSON, for the reason the baseline gives at
 * length: `table.json()` is a native `json` column on postgres, where
 * `node-postgres` parses it back to a JS object, and `text` on sqlite, where it
 * comes back a string — so `text` is the only type whose read-back value is
 * byte-identical on both dialects, which is what lets the store parse it in one
 * code path instead of a `typeof === 'string'` fork. A child table keyed by
 * repository was the alternative and buys nothing: the list is written whole,
 * read whole, and never filtered or joined on.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('bruno_sweep_report', (table) => {
    table.comment('The latest completed bruno.discovery sweep');

    // A SINGLETON row, and the primary key is what enforces that. There is one
    // sweeper in the instance and the report is the whole of its last answer,
    // so an append-only history would grow forever to serve a route that only
    // ever asks for the newest row.
    table.text('id').primary().comment("Always 'latest'; one row by design");
    table.text('swept_at').notNullable().comment('ISO 8601 time of the sweep');
    // NOT nullable and NOT defaulted: an empty array is a real answer ("swept,
    // everything was complete") and the absence of the ROW is the other one
    // ("no sweep has ever been recorded"). A nullable column would add a third
    // state that means neither.
    table
      .text('incomplete')
      .notNullable()
      .comment('JSON array of repositories whose listing was partial');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('bruno_sweep_report');
};
