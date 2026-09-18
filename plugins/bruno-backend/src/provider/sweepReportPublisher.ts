import type { AuthService, DiscoveryService } from '@backstage/backend-plugin-api';
import type { SweepReport } from '../discovery';

export interface SweepReportPublisher {
  /** Records `report` as the latest completed sweep. */
  publish(report: SweepReport): Promise<void>;
}

/**
 * Writes the latest sweep report to `PUT /api/bruno/discovery/report`,
 * service-to-service.
 *
 * THE WIRING PROBLEM THIS SOLVES, since an in-memory field would look simpler
 * and be wrong twice over. The sweep runs in `brunoCatalogModule` (registered
 * under `pluginId: 'catalog'`) and the route that reports it is in the `bruno`
 * plugin — two separate backend features with no in-process link, which is
 * exactly why `storedCollections.ts` next to this file already reaches that
 * plugin over HTTP with a plugin token. On top of that the provider's scheduled
 * task is `scope: 'global'`, so the sweep runs on ONE replica while the route
 * is served from all N: a field on the router would answer "nothing to report"
 * from every replica but one, at random, which is the worst possible answer for
 * a strip whose whole job is to say when something IS missing. So the report
 * goes where the plugin's other cross-replica state goes — its database — and
 * this is the only way to put it there from here.
 *
 * The direction is the mirror image of `storedCollections`: that reads the
 * plugin's store for the provider, this writes to it. Same token hygiene, and
 * for the same reason — the token is a function-local `const` used only as the
 * `Authorization` header, never stored, never logged, and the error thrown on a
 * non-OK response carries the STATUS and STATUS TEXT only, because the caller
 * logs it and a message echoing the request would smuggle the bearer token into
 * the backend log.
 *
 * This publisher THROWS and never logs, like every other reader here. What is
 * different is what the caller does with the throw: a failed publish costs a
 * stale report and nothing else, so the provider logs it and carries on. It
 * must never fail a tick — the catalog entities are the product, this is a
 * diagnostic about them.
 */
export function createSweepReportPublisher(options: {
  discovery: DiscoveryService;
  auth: AuthService;
}): SweepReportPublisher {
  const { discovery, auth } = options;

  return {
    async publish(report: SweepReport): Promise<void> {
      const baseUrl = await discovery.getBaseUrl('bruno');
      const { token } = await auth.getPluginRequestToken({
        onBehalfOf: await auth.getOwnServiceCredentials(),
        targetPluginId: 'bruno'
      });
      // `collections` is deliberately NOT sent. They are already travelling to
      // the catalog as entities, and a report that carried them too would be a
      // second, staler copy of the same list for a route that has no use for
      // it. What the route stores is the part the entities cannot express.
      const res = await fetch(`${baseUrl}/discovery/report`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sweptAt: report.sweptAt,
          incomplete: report.incomplete
        })
      });
      if (!res.ok) {
        throw new Error(
          `PUT /discovery/report failed with ${res.status} ${res.statusText}`
        );
      }
    }
  };
}
