import type { DatabaseService } from '@backstage/backend-plugin-api';

export interface BrunoConnectionRow {
  entityRef: string;
  sourceUrl: string;
  collectionId: string;
  connectedBy: string;
  updatedAt: string;
}

export interface ConnectionStore {
  upsert(row: Omit<BrunoConnectionRow, 'updatedAt'>): Promise<void>;
  getByEntityRef(entityRef: string): Promise<BrunoConnectionRow | undefined>;
  delete(entityRef: string): Promise<void>;
  listAll(): Promise<BrunoConnectionRow[]>;
}

type RawRow = {
  entity_ref: string;
  source_url: string;
  collection_id: string;
  connected_by: string;
  updated_at: string;
};

function rowToModel(row: RawRow): BrunoConnectionRow {
  return {
    entityRef: row.entity_ref,
    sourceUrl: row.source_url,
    collectionId: row.collection_id,
    connectedBy: row.connected_by,
    updatedAt: row.updated_at
  };
}

export async function createConnectionStore(
  database: DatabaseService
): Promise<ConnectionStore> {
  const client = await database.getClient();

  if (!(await client.schema.hasTable('bruno_connections'))) {
    try {
      await client.schema.createTable('bruno_connections', (table) => {
        table.text('entity_ref').primary();
        table.text('source_url').notNullable();
        table.text('collection_id').notNullable();
        table.text('connected_by').notNullable();
        table.text('updated_at').notNullable();
      });
    } catch (error) {
      // Tolerate a concurrent creator (e.g. a second backend replica) that won
      // the race; only rethrow if the table genuinely still does not exist.
      if (!(await client.schema.hasTable('bruno_connections'))) {
        throw error;
      }
    }
  }

  return {
    async upsert(row): Promise<void> {
      await client('bruno_connections')
        .insert({
          entity_ref: row.entityRef,
          source_url: row.sourceUrl,
          collection_id: row.collectionId,
          connected_by: row.connectedBy,
          updated_at: new Date().toISOString()
        })
        .onConflict('entity_ref')
        .merge();
    },
    async getByEntityRef(entityRef): Promise<BrunoConnectionRow | undefined> {
      const row = await client('bruno_connections')
        .where({ entity_ref: entityRef })
        .first();
      return row ? rowToModel(row as RawRow) : undefined;
    },
    async delete(entityRef): Promise<void> {
      await client('bruno_connections').where({ entity_ref: entityRef }).delete();
    },
    async listAll(): Promise<BrunoConnectionRow[]> {
      const rows = await client('bruno_connections').select('*');
      return (rows as RawRow[]).map(rowToModel);
    }
  };
}
