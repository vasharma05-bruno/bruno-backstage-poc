import type { AuthService, DiscoveryService } from '@backstage/backend-plugin-api';

/**
 * One link made in this instance rather than in source control, as the catalog
 * module sees it.
 *
 * The `bruno` plugin's `RuntimeLinkRow` minus `createdBy` and `createdAt`,
 * declared separately because this is the far side of an HTTP boundary: the
 * catalog module has no access to that plugin's store and must not pretend
 * otherwise. The two audit columns are dropped rather than carried — the
 * processor turns rows into relations and has no business holding who made
 * them, and a field nothing reads is a field that ends up in a log line.
 */
export interface RuntimeLink {
  /** Canonical ref of the Bruno collection the link belongs to. */
  collectionRef: string;
  /** Canonical ref of the API entity it points at. */
  apiRef: string;
}

export interface RuntimeLinkReader {
  list(): Promise<RuntimeLink[]>;
}

/**
 * Reads `GET /api/bruno/links` service-to-service.
 *
 * Same shape and same reasoning as `provider/storedCollections.ts` next door:
 * the catalog module and the `bruno` plugin are separate backend features with
 * no in-process wiring, so the processor cannot hold the store object; it holds
 * this, and the call is authenticated with a plugin token minted for the
 * `bruno` plugin. That is why the route's allow-list is `['service']`.
 *
 * TOKEN HYGIENE, as on that reader: the token is a function-local `const` used
 * only as the `Authorization` header — never returned, never stored on the
 * reader, never interpolated into an `Error` or a log line. The error thrown on
 * a non-OK response carries the STATUS and STATUS TEXT only, because the caller
 * logs it and a message echoing the request would smuggle the bearer token into
 * the backend log.
 *
 * WHY THERE IS NO TTL CACHE, which is the one thing this reader does
 * differently. `BrunoKindProcessor` calls it once per Bruno entity per
 * processing cycle, and the obvious optimisation is to cache the list for a few
 * seconds. It is the wrong optimisation here: `POST /links` marks the
 * collection for IMMEDIATE reprocessing precisely so the relation appears
 * within seconds, and a cache filled a moment before that write answers the
 * reprocess with the old list. The entity is then not due again for a full
 * processing interval — minutes — so a cache window of seconds buys a handful
 * of requests and costs the entire point of the fast path.
 *
 * What is deduplicated instead is CONCURRENCY: the engine processes entities in
 * parallel, so calls that overlap share one in-flight request. That collapses a
 * sweep of a whole catalog into a few reads without ever answering from a
 * result that predates the caller.
 *
 * This reader THROWS and never logs, and never substitutes an empty list for a
 * failure — the processor must be able to tell "no links" from "I could not
 * ask", because the first means delete the relations and the second means keep
 * the last set it knew about. Collapsing them here would put that decision
 * somewhere it cannot be made.
 */
export function createRuntimeLinkReader(options: {
  discovery: DiscoveryService;
  auth: AuthService;
}): RuntimeLinkReader {
  const { discovery, auth } = options;

  /** The request currently in flight, shared by every overlapping caller. */
  let inFlight: Promise<RuntimeLink[]> | undefined;

  const fetchLinks = async (): Promise<RuntimeLink[]> => {
    const baseUrl = await discovery.getBaseUrl('bruno');
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: await auth.getOwnServiceCredentials(),
      targetPluginId: 'bruno'
    });
    const res = await fetch(`${baseUrl}/links`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      throw new Error(
        `GET /links failed with ${res.status} ${res.statusText}`
      );
    }

    // An ENVELOPE, asserted rather than tolerated: a bare array here would mean
    // the route is not the one in this repository, and quietly coping with that
    // is how relations end up derived from something nobody recognised.
    const body: unknown = await res.json();
    const links
      = typeof body === 'object' && body !== null
        ? (body as { links?: unknown }).links
        : undefined;
    if (!Array.isArray(links)) {
      throw new Error('GET /links returned a body with no `links` array');
    }

    // Per-row shape guard, tolerant like the stored-collection reader: a row
    // missing either ref cannot name a relation, so it is dropped and the rest
    // of the links still reach the catalog. Throwing on one malformed row would
    // take every other link in the instance down with it.
    const rows: RuntimeLink[] = [];
    for (const raw of links as unknown[]) {
      if (typeof raw !== 'object' || raw === null) {
        continue;
      }
      const row = raw as Record<string, unknown>;
      if (
        typeof row.collectionRef !== 'string'
        || !row.collectionRef
        || typeof row.apiRef !== 'string'
        || !row.apiRef
      ) {
        continue;
      }
      rows.push({ collectionRef: row.collectionRef, apiRef: row.apiRef });
    }
    return rows;
  };

  return {
    async list(): Promise<RuntimeLink[]> {
      if (inFlight) {
        return inFlight;
      }
      // Cleared in a `finally` rather than on success, so a failed read does
      // not pin every later caller to the same rejection.
      const request = fetchLinks().finally(() => {
        if (inFlight === request) {
          inFlight = undefined;
        }
      });
      inFlight = request;
      return request;
    }
  };
}
