import { isDatabaseConflictError } from '@backstage/backend-plugin-api';
import type { DatabaseService } from '@backstage/backend-plugin-api';
import { ConflictError } from '@backstage/errors';

const TABLE = 'bruno_ui_collections';

/**
 * One collection added from the Bruno dashboard.
 *
 * This row is the WRITE MODEL for a UI-created collection, and it is the only
 * one there is. The catalog is a read model built by `BrunoCollectionEntityProvider`
 * on its scheduled tick, so nothing here is derived from the catalog and nothing
 * in the catalog is authoritative over it: delete a row and the entity goes on
 * the next tick, keep the row and the entity comes back however often the
 * catalog is rebuilt.
 */
export interface UiCollectionRow {
  /** `metadata.name` of the Bruno entity. Primary key. */
  name: string;
  /**
   * `metadata.title` of the Bruno entity, when the creator chose one.
   *
   * NULL in the column means "no authored title", which is not the same as an
   * empty one: `BrunoCollectionEntityProvider` omits the key from the emitted
   * entity, and `BrunoKindProcessor` then fills it from the collection manifest
   * on every processing cycle. An empty string would be an authored title that
   * displays as nothing, so the route collapses blanks to NULL.
   */
  title?: string;
  /** The normalized collection folder URL. */
  url: string;
  owner?: string;
  partOf: string[];
  /** Entity ref of the user who added it. Read back by
   *  `DELETE /collections/:name`, which refuses to remove a collection the
   *  caller did not add unless the policy ALLOWs
   *  `bruno.collection.delete.any`. */
  createdBy: string;
  createdAt: string;
}

export interface UiCollectionStore {
  insert(row: Omit<UiCollectionRow, 'createdAt'>): Promise<void>;
  getByName(name: string): Promise<UiCollectionRow | undefined>;
  listAll(): Promise<UiCollectionRow[]>;
  /** True when a row was removed, false when there was none. */
  delete(name: string): Promise<boolean>;
}

type RawRow = {
  name: string;
  title: string | null;
  url: string;
  owner: string | null;
  part_of: string;
  created_by: string;
  created_at: string;
};

/**
 * `part_of` back into a `string[]`, tolerating anything.
 *
 * This is one code path rather than a `typeof === 'string' ? JSON.parse(…) : …`
 * fork BECAUSE the column is `text` on both dialects; the baseline migration
 * holds the reasoning and the warning against changing it. A join table was the
 * other candidate and buys index-able membership queries nobody asks for —
 * `partOf` is copied verbatim into `spec.partOf` and is never filtered or
 * joined on — at the price of referential integrity sqlite does not enforce
 * unless `PRAGMA foreign_keys = ON`, which Backstage's connector does not
 * guarantee.
 *
 * Tolerant rather than strict, mirroring `readPartOf` in
 * `service/brunoConfig.ts`: a row whose `part_of` cannot be read is still a
 * collection the user created, and dropping it from the catalog over an
 * unparseable relation list would be a far worse answer than emitting it with
 * no relations.
 */
function parsePartOf(raw: unknown): string[] {
  if (typeof raw !== 'string') {
    return [];
  }
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? value
      : [];
  } catch {
    return [];
  }
}

function rowToModel(row: RawRow): UiCollectionRow {
  return {
    name: row.name,
    // Truthiness, not a null check: the column can hold `''` on a row written
    // before the route collapsed blanks, and an empty title has to read as
    // absent here too or it would author one on the entity.
    ...(row.title ? { title: row.title } : {}),
    url: row.url,
    ...(row.owner ? { owner: row.owner } : {}),
    partOf: parsePartOf(row.part_of),
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

/**
 * The store behind `POST`/`GET`/`DELETE /api/bruno/collections`.
 *
 * Pure data access: the table is created and evolved by `store/migrations.ts`,
 * which `plugin.ts` runs to completion before this factory is called. Nothing
 * here may create or widen a column — a schema change that a store applied on
 * boot would be invisible to `knex_migrations` and could never be rolled
 * forward or back afterwards.
 */
export async function createUiCollectionStore(
  database: DatabaseService
): Promise<UiCollectionStore> {
  const client = await database.getClient();

  return {
    async insert(row): Promise<void> {
      // Deliberately NOT `.onConflict().merge()`, which is what the removed
      // connection store did. A duplicate name is an error the user has to
      // see — silently overwriting would take a collection somebody else added
      // and repoint it at a different repository, with no trace of the one that
      // was there. The route pre-checks the name; this catch exists for the
      // race between two concurrent creates, and rethrows the pre-check's own
      // message so both paths read identically to the user.
      try {
        await client(TABLE).insert({
          name: row.name,
          // `?? null` rather than omitting the key, so the INSERT names every
          // column on both dialects and a row written here is shaped like one
          // written by any other path.
          title: row.title ?? null,
          url: row.url,
          owner: row.owner ?? null,
          part_of: JSON.stringify(row.partOf ?? []),
          created_by: row.createdBy,
          created_at: new Date().toISOString()
        });
      } catch (error) {
        if (isDatabaseConflictError(error)) {
          throw new ConflictError(
            `A collection named "${row.name}" has already been added from the `
            + 'Bruno UI. Pick a different name.'
          );
        }
        throw error;
      }
    },
    /**
     * Looks a row up CASE-INSENSITIVELY, and this is the canonical explanation
     * of why — `service/router.ts`'s config-collision loop and the provider's
     * `claimed` map fold the same way and point back here.
     *
     * A catalog entity ref is lower-cased component by component when it is
     * stringified: `stringifyEntityRef` in `@backstage/catalog-model` lower-cases
     * the kind, the namespace AND the name. So `bruno:default/Payments` and
     * `bruno:default/payments` are not two entities that look alike — they are
     * ONE entity, and whichever of the two rows is emitted second collides with
     * the first on a single `refresh_state` row under a single `locationKey`.
     * A raw string comparison here answers 201 to a create that can only ever
     * produce nothing, and the dialog then polls a ref that resolves to somebody
     * else's collection and links the user straight to it.
     *
     * `whereRaw('lower(name) = ?')` rather than knex's `whereILike`, because
     * `lower()` is the one spelling that behaves identically on better-sqlite3
     * and on postgres: `ILIKE` is postgres-only, and `LIKE` would additionally
     * treat `_` and `%` in the name as wildcards — both are legal characters in
     * `ENTITY_NAME_PATTERN`. `lower()` is ASCII-only on sqlite, which costs
     * nothing here: the entity-name grammar admits ASCII alphanumerics, dashes,
     * underscores and dots and nothing else.
     *
     * What is NOT folded is what gets STORED. `metadata.name` keeps the casing
     * the user chose, because that is what the catalog shows them; only the
     * comparison is case-insensitive.
     */
    async getByName(name): Promise<UiCollectionRow | undefined> {
      const row = await client(TABLE)
        .whereRaw('lower(name) = ?', [name.toLocaleLowerCase('en-US')])
        .first();
      return row ? rowToModel(row as RawRow) : undefined;
    },
    async listAll(): Promise<UiCollectionRow[]> {
      const rows = await client(TABLE).select('*');
      return (rows as RawRow[]).map(rowToModel);
    },
    /**
     * Folds case exactly as {@link UiCollectionStore.getByName} does, and the
     * two MUST stay identical.
     *
     * Today a mismatch is a latent 404: `DELETE /collections/Payments` finds no
     * row under a raw comparison while `getByName` would have found `payments`,
     * so the route answers "no collection named that" about a collection that
     * exists. The moment an ownership check lands on the route — the Beta
     * hardening its IDOR note describes — it stops being latent: the check
     * reads the row `getByName` resolves and the delete then removes whatever
     * the other comparison matches, which is a DIFFERENT row or none. An
     * authorization decision and the write it authorises have to be about the
     * same row.
     */
    async delete(name): Promise<boolean> {
      // The count is the whole point: the route turns "no row" into a 404 that
      // explains a config- or descriptor-origin collection cannot be deleted
      // here, and a delete that silently succeeded would leave the user waiting
      // for an entity that is never going to disappear.
      const removed = await client(TABLE)
        .whereRaw('lower(name) = ?', [name.toLocaleLowerCase('en-US')])
        .delete();
      return removed > 0;
    }
  };
}
