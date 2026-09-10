import type { AuthService, DiscoveryService } from '@backstage/backend-plugin-api';

/**
 * One collection added from the Bruno dashboard, as the catalog module sees it.
 *
 * Structurally the `bruno` plugin's `UiCollectionRow`, declared separately
 * because this is the far side of an HTTP boundary: the catalog module has no
 * access to that plugin's store and must not pretend otherwise. If the two ever
 * disagree, the per-row guard below is what keeps the provider running.
 */
export interface StoredCollection {
  name: string;
  /** `metadata.title` the creator chose, absent when they left it to the
   *  collection manifest. */
  title?: string;
  url: string;
  owner?: string;
  partOf: string[];
  createdBy: string;
  createdAt: string;
}

export interface StoredCollectionReader {
  list(): Promise<StoredCollection[]>;
}

/**
 * Reads `GET /api/bruno/collections` service-to-service.
 *
 * The catalog module and the `bruno` plugin are separate backend features with
 * no in-process wiring between them, so the provider cannot hold the store
 * object; it holds this, and the call is authenticated with a plugin token
 * minted for the `bruno` plugin. That is exactly why the route's allow-list is
 * `['service']`.
 *
 * TOKEN HYGIENE — the whole reason this is a module and not three lines inside
 * the provider. The token is a function-local `const`, used only as the
 * `Authorization` header: never returned, never stored on the reader, never
 * interpolated into an `Error` message or a log line. The error thrown on a
 * non-OK response carries the STATUS and STATUS TEXT only — never the body,
 * never the request headers — because the caller logs it, and a message that
 * echoed the request would smuggle the bearer token into the backend log.
 *
 * This reader THROWS and never logs. The caller logs, with the structured
 * second argument (`logger.warn(msg, error)`, never string interpolation).
 *
 * And it deliberately does NOT swallow failures the way the old link processor
 * did by returning a stale-or-empty map. The provider must be able to tell "the
 * list is empty" from "I could not ask", because under a `full` catalog
 * mutation those two have opposite consequences: the first is a legitimate
 * state, the second would delete every UI-created collection in the instance.
 * Collapsing them here would put that decision somewhere it cannot be made.
 */
export function createStoredCollectionReader(options: {
  discovery: DiscoveryService;
  auth: AuthService;
}): StoredCollectionReader {
  const { discovery, auth } = options;

  return {
    async list(): Promise<StoredCollection[]> {
      const baseUrl = await discovery.getBaseUrl('bruno');
      const { token } = await auth.getPluginRequestToken({
        onBehalfOf: await auth.getOwnServiceCredentials(),
        targetPluginId: 'bruno'
      });
      const res = await fetch(`${baseUrl}/collections`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        throw new Error(
          `GET /collections failed with ${res.status} ${res.statusText}`
        );
      }
      // The route answers with an ENVELOPE — `{ collections, refreshSeconds }` —
      // because the dashboard needs the provider's tick alongside the rows to
      // tell a collection that is still landing from one that never will. This
      // reader wants only the rows, but it asserts the envelope rather than
      // accepting either shape: a bare array here would mean the route is not
      // the one in this repository, and quietly coping with that is how a
      // provider ends up emitting a set built from something it did not
      // recognise, under a `full` mutation.
      const body: unknown = await res.json();
      const collections
        = typeof body === 'object' && body !== null
          ? (body as { collections?: unknown }).collections
          : undefined;
      if (!Array.isArray(collections)) {
        throw new Error(
          'GET /collections returned a body with no `collections` array'
        );
      }

      // Per-row shape guard, tolerant like the config reader: a row missing the
      // two fields an entity cannot be built without is dropped, and the rest
      // of the list still reaches the catalog. Throwing on one malformed row
      // would take every other UI-created collection down with it.
      const rows: StoredCollection[] = [];
      for (const raw of collections as unknown[]) {
        if (typeof raw !== 'object' || raw === null) {
          continue;
        }
        const row = raw as Record<string, unknown>;
        if (
          typeof row.name !== 'string'
          || !row.name
          || typeof row.url !== 'string'
          || !row.url
        ) {
          continue;
        }
        rows.push({
          name: row.name,
          // Not one of the two fields a row is dropped for missing: a title is
          // legitimately absent, and it is the only field here whose absence is
          // an instruction rather than a defect — the provider omits the key and
          // the processor derives the title from the manifest instead.
          ...(typeof row.title === 'string' && row.title
            ? { title: row.title }
            : {}),
          url: row.url,
          ...(typeof row.owner === 'string' && row.owner
            ? { owner: row.owner }
            : {}),
          partOf:
            Array.isArray(row.partOf)
            && row.partOf.every((v) => typeof v === 'string')
              ? (row.partOf as string[])
              : [],
          createdBy: typeof row.createdBy === 'string' ? row.createdBy : '',
          createdAt: typeof row.createdAt === 'string' ? row.createdAt : ''
        });
      }
      return rows;
    }
  };
}
