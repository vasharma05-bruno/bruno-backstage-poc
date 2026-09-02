import { isDatabaseConflictError } from '@backstage/backend-plugin-api';
import type { DatabaseService } from '@backstage/backend-plugin-api';
import { ConflictError } from '@backstage/errors';

const TABLE = 'bruno_runtime_links';

/**
 * One link made in this Backstage instance rather than in source control.
 *
 * A `spec.partOf` entry in a collection's `catalog-info.yaml` is the link
 * everybody agrees on: it is reviewable, it survives a rebuild of the database,
 * and it is what a pull request edits. This row is the other kind — the link a
 * user makes when there is no descriptor to edit (a `bruno.collections[]`
 * entry, a discovered collection, a descriptor on a host that takes no
 * automatic pull request) or when they do not want to wait for a review.
 *
 * It is a WRITE MODEL, like `bruno_ui_collections` next to it, and for the same
 * reason: the catalog has no write model of its own, so a relation cannot be
 * inserted into it. `BrunoKindProcessor` reads these rows back over HTTP and
 * stamps them on the collection entity as `usebruno.com/runtime-part-of`, from
 * which it emits the same `partOf`/`hasPart` pair `spec.partOf` produces. That
 * indirection is what makes the link durable: relations are derived output,
 * recomputed and rewritten on every stitch, so anything written straight into a
 * relation row would be reverted within one processing cycle. Re-derived from
 * this table on every cycle, it is not.
 *
 * Both halves are stored CANONICAL — `stringifyEntityRef` output, which is
 * lower-cased component by component. See `service/entityRefs.ts` for why the
 * two ends of the link must agree on one spelling.
 */
export interface RuntimeLinkRow {
  /** Canonical ref of the Bruno collection, e.g. `bruno:default/payments`. */
  collectionRef: string;
  /** Canonical ref of the API entity, e.g. `api:default/github-rest-api`. */
  apiRef: string;
  /** Entity ref of the user who made the link. Recorded, not enforced (POC). */
  createdBy: string;
  createdAt: string;
}

export interface RuntimeLinkStore {
  /**
   * Writes one collection's links, all of them or none.
   *
   * Plural because the collection-side dialog picks several APIs at once and
   * they all land in the same `partOf`: one call, one refresh, and either every
   * link the user chose exists or none of them do. Rejects with a
   * {@link ConflictError} when any pair is already linked.
   */
  insert(rows: Omit<RuntimeLinkRow, 'createdAt'>[]): Promise<void>;
  /** True when a row was removed, false when there was none. */
  delete(collectionRef: string, apiRef: string): Promise<boolean>;
  /** Drops every link for one collection. Returns how many went. */
  deleteForCollection(collectionRef: string): Promise<number>;
  /** The API refs already linked to one collection. */
  listForCollection(collectionRef: string): Promise<string[]>;
  listAll(): Promise<RuntimeLinkRow[]>;
}

type RawRow = {
  collection_ref: string;
  api_ref: string;
  created_by: string;
  created_at: string;
};

function rowToModel(row: RawRow): RuntimeLinkRow {
  return {
    collectionRef: row.collection_ref,
    apiRef: row.api_ref,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

/**
 * The store behind `GET`/`POST`/`DELETE /api/bruno/links`.
 *
 * Create-table-if-not-exists rather than a formal migration, matching
 * `uiCollectionStore` beside it: the table has one shape and a POC that has to
 * be re-pointed at a fresh database on every schema change is a worse trade
 * than the knex migration machinery.
 *
 * The primary key is the PAIR, which is the whole integrity model: a link
 * either exists or it does not, there is nothing to update, and a second
 * `POST /links` for the same pair is a conflict rather than a duplicate row.
 * Both columns are `text` for the reason `parsePartOf` gives next door — it is
 * the one column type whose read-back value is byte-identical on
 * better-sqlite3 and on postgres.
 */
export async function createRuntimeLinkStore(
  database: DatabaseService
): Promise<RuntimeLinkStore> {
  const client = await database.getClient();

  if (!(await client.schema.hasTable(TABLE))) {
    try {
      await client.schema.createTable(TABLE, (table) => {
        table.text('collection_ref').notNullable();
        table.text('api_ref').notNullable();
        table.text('created_by').notNullable();
        table.text('created_at').notNullable();
        table.primary(['collection_ref', 'api_ref']);
        // The processor reads the whole table and groups by collection, but the
        // routes look one collection up at a time, and `deleteForCollection`
        // runs on every UI-collection delete.
        table.index(['collection_ref']);
      });
    } catch (error) {
      // Tolerate a concurrent creator (a second backend replica) that won the
      // race; only rethrow if the table genuinely still does not exist.
      if (!(await client.schema.hasTable(TABLE))) {
        throw error;
      }
    }
  }

  return {
    async insert(rows): Promise<void> {
      if (rows.length === 0) {
        return;
      }
      const createdAt = new Date().toISOString();
      // ONE statement, so the whole selection lands or none of it does. Knex
      // sends a multi-row insert on both dialects, and a unique violation on
      // any pair fails the statement — which is the behaviour a user picking
      // four APIs wants: a half-applied selection is a screen nobody can read.
      //
      // Deliberately NOT `.onConflict().ignore()`. A second link of the same
      // pair means the user is looking at a stale screen — the relation is
      // already there, or is one processing cycle from being there — and
      // silently answering 201 would have them wait for a change that already
      // happened. The route pre-checks and names the offending refs; this catch
      // exists for the race between two concurrent clicks.
      try {
        await client(TABLE).insert(
          rows.map((row) => ({
            collection_ref: row.collectionRef,
            api_ref: row.apiRef,
            created_by: row.createdBy,
            created_at: createdAt
          }))
        );
      } catch (error) {
        if (isDatabaseConflictError(error)) {
          throw new ConflictError(
            `${rows.length === 1 ? rows[0].apiRef : 'One of those APIs'} is `
            + `already linked to ${rows[0].collectionRef} in this Backstage `
            + 'instance.'
          );
        }
        throw error;
      }
    },
    async delete(collectionRef, apiRef): Promise<boolean> {
      // The count is the point: the route turns "no row" into a 404 that
      // explains a link declared by `spec.partOf` is removed by editing that
      // file, and a delete that silently succeeded would leave the user waiting
      // for a relation that is never going to disappear.
      const removed = await client(TABLE)
        .where({ collection_ref: collectionRef, api_ref: apiRef })
        .delete();
      return removed > 0;
    },
    async deleteForCollection(collectionRef): Promise<number> {
      return client(TABLE).where({ collection_ref: collectionRef }).delete();
    },
    async listForCollection(collectionRef): Promise<string[]> {
      const rows = await client(TABLE)
        .where({ collection_ref: collectionRef })
        .select('api_ref');
      return (rows as Pick<RawRow, 'api_ref'>[]).map((row) => row.api_ref);
    },
    async listAll(): Promise<RuntimeLinkRow[]> {
      const rows = await client(TABLE).select('*');
      return (rows as RawRow[]).map(rowToModel);
    }
  };
}
