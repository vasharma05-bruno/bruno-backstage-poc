import type { DatabaseService } from '@backstage/backend-plugin-api';

export interface ImportedCollectionRow {
  collectionId: string;
  githubUrl: string;
  name: string;
  importedBy: string;
  updatedAt: string;
}

export interface CollectionsStore {
  upsert(row: Omit<ImportedCollectionRow, 'updatedAt'>): Promise<void>;
  listAll(): Promise<ImportedCollectionRow[]>;
  delete(collectionId: string): Promise<void>;
}

type RawRow = {
  collection_id: string;
  github_url: string;
  name: string;
  imported_by: string;
  updated_at: string;
};

function rowToModel(row: RawRow): ImportedCollectionRow {
  return {
    collectionId: row.collection_id,
    githubUrl: row.github_url,
    name: row.name,
    importedBy: row.imported_by,
    updatedAt: row.updated_at
  };
}

export async function createCollectionsStore(
  database: DatabaseService
): Promise<CollectionsStore> {
  const client = await database.getClient();

  if (!(await client.schema.hasTable('bruno_collections'))) {
    try {
      await client.schema.createTable('bruno_collections', (table) => {
        table.text('collection_id').primary();
        table.text('github_url').notNullable();
        table.text('name').notNullable();
        table.text('imported_by').notNullable();
        table.text('updated_at').notNullable();
      });
    } catch (error) {
      // Tolerate a concurrent creator (e.g. a second backend replica) that won
      // the race; only rethrow if the table genuinely still does not exist.
      if (!(await client.schema.hasTable('bruno_collections'))) {
        throw error;
      }
    }
  }

  return {
    async upsert(row): Promise<void> {
      await client('bruno_collections')
        .insert({
          collection_id: row.collectionId,
          github_url: row.githubUrl,
          name: row.name,
          imported_by: row.importedBy,
          updated_at: new Date().toISOString()
        })
        .onConflict('collection_id')
        .merge();
    },
    async listAll(): Promise<ImportedCollectionRow[]> {
      const rows = await client('bruno_collections').select('*');
      return (rows as RawRow[]).map(rowToModel);
    },
    async delete(collectionId): Promise<void> {
      await client('bruno_collections')
        .where({ collection_id: collectionId })
        .delete();
    }
  };
}
