import type { DatabaseService } from '@backstage/backend-plugin-api';

const TABLE = 'bruno_sweep_report';

/** The single row's primary key. See the migration for why there is only one. */
const SINGLETON = 'latest';

/**
 * One repository the sweep read successfully and could not read ALL of.
 *
 * Structurally `IncompleteRepository` in `discovery/types.ts`, declared
 * separately for the reason `provider/storedCollections.ts` gives about its own
 * twin: this is the far side of an HTTP boundary. The sweep lives in the
 * catalog module and puts this shape on the wire; the store is the `bruno`
 * plugin's and receives it. Letting one type serve both would hide the fact
 * that a redeployed module and an older plugin can disagree, which is what the
 * route's per-entry guard exists for.
 *
 * `reason` is a union of one today and stays a union: `listing-limit` says the
 * host would not list any more files, and the next member — whatever it is —
 * will need its own sentence on screen rather than the same one.
 */
export interface IncompleteRepositoryRow {
  /** `owner/repo`. */
  repository: string;
  host: string;
  /** How many collections were found there in spite of the cap. */
  found: number;
  reason: 'listing-limit';
}

/** The latest sweep, as the route reports it. */
export interface SweepReportRow {
  sweptAt: string;
  incomplete: IncompleteRepositoryRow[];
}

export interface SweepReportStore {
  /** Replaces the recorded report. */
  save(report: SweepReportRow): Promise<void>;
  /**
   * The recorded report, or undefined when there is none.
   *
   * Undefined is a THIRD state, not a convenience for an empty list: it means
   * no sweep has ever been recorded — `bruno.discovery[]` is unconfigured, or
   * the provider has not finished its first tick — and a caller that collapsed
   * it into "swept, nothing incomplete" would report an unswept instance as a
   * healthy one.
   */
  get(): Promise<SweepReportRow | undefined>;
}

type RawRow = {
  id: string;
  swept_at: string;
  incomplete: string;
};

/**
 * Parses `incomplete` back into rows, dropping anything malformed.
 *
 * Tolerant rather than strict, like `parsePartOf` in `uiCollectionStore.ts`: a
 * report is a diagnostic, and a single unreadable entry must cost that entry
 * rather than the whole report — which would hide every OTHER repository that
 * is genuinely missing collections.
 */
function parseIncomplete(raw: unknown): IncompleteRepositoryRow[] {
  if (typeof raw !== 'string') {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: IncompleteRepositoryRow[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    if (
      typeof row.repository !== 'string'
      || typeof row.host !== 'string'
      || typeof row.found !== 'number'
      || row.reason !== 'listing-limit'
    ) {
      continue;
    }
    rows.push({
      repository: row.repository,
      host: row.host,
      found: row.found,
      reason: 'listing-limit'
    });
  }
  return rows;
}

/**
 * The store behind `GET`/`PUT /api/bruno/discovery/report`.
 *
 * Pure data access, like the two stores beside it: the table is owned by
 * `store/migrations.ts`, which `plugin.ts` runs before this factory is called.
 *
 * Not a write model in the sense the other two are. `bruno_ui_collections` and
 * `bruno_runtime_links` hold things a USER created and nothing else can
 * recreate; this holds a DERIVED fact that the next sweep rewrites, so losing
 * the row costs at most one tick. That is why `save` is an upsert with no
 * conflict handling to speak of and why nothing here is permissioned — the only
 * writer is this plugin's own provider, authenticated as a service.
 */
export async function createSweepReportStore(
  database: DatabaseService
): Promise<SweepReportStore> {
  const client = await database.getClient();

  return {
    async save(report): Promise<void> {
      const row = {
        id: SINGLETON,
        swept_at: report.sweptAt,
        incomplete: JSON.stringify(report.incomplete)
      };
      // `merge` rather than delete-then-insert: the provider's task is
      // `scope: 'global'` so there is normally one writer, but a leadership
      // handover can overlap two ticks, and a delete-then-insert pair would
      // leave a window in which the route answers "never swept" to a dashboard
      // that has been swept every minute for a month.
      await client(TABLE)
        .insert(row)
        .onConflict('id')
        .merge(['swept_at', 'incomplete']);
    },
    async get(): Promise<SweepReportRow | undefined> {
      const row = await client(TABLE).where({ id: SINGLETON }).first();
      if (!row) {
        return undefined;
      }
      const raw = row as RawRow;
      return {
        sweptAt: raw.swept_at,
        incomplete: parseIncomplete(raw.incomplete)
      };
    }
  };
}
