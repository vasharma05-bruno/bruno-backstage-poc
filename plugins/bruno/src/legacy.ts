import {
  createApiFactory,
  createComponentExtension,
  createPlugin,
  createRoutableExtension,
  createRouteRef,
  discoveryApiRef,
  fetchApiRef
} from '@backstage/core-plugin-api';
import { brunoApiRef } from './api/BrunoApi';
import { BrunoClient } from './api/BrunoClient';

/**
 * `@usebruno/bruno-plugin-poc/legacy` — the same plugin, wired for the LEGACY
 * Backstage frontend system.
 *
 * The package's main entry point (`src/index.ts`) is new-frontend-system only:
 * an app there registers one default export and every surface appears by
 * itself. Most production Backstage installs still run the legacy system, where
 * an adopter composes the app by hand in `packages/app/src/components/catalog/
 * EntityPage.tsx`. This entry point gives those apps the same components
 * through the legacy `createPlugin` / extension API, so neither system has to
 * be emulated inside the other.
 *
 * **Bundle isolation is the point, and it is structural.** `.` and `./legacy`
 * are separate rollup inputs (see the `exports` field in `package.json`), and
 * nothing reachable from this file imports `./plugin` or `./extensions` — so no
 * blueprint, and none of the new system's extension runtime, can reach a legacy
 * app's bundle. `src/legacy.test.ts` walks that module graph and fails if the
 * property is ever broken. `./legacy` is equally invisible in the other
 * direction: the CLI's package detection auto-discovers the hardcoded `./alpha`
 * subpath alone, so this entry point can never be loaded into a new-system app
 * by accident.
 *
 * **`BrunoEntityHeader` is deliberately absent.** It is typed on
 * `EntityHeaderLayoutProps`, a contract that exists only because the new
 * system hands a replacement header its own tab model (`{ tabs, activeTabId }`).
 * Legacy `EntityLayout` renders its own header and exposes no equivalent slot,
 * so there is nothing here for that component to plug into. Legacy adopters get
 * the stock entity header; the collection's version, source URL and own actions
 * are reachable from the Overview cards instead.
 */

/**
 * Mount point for {@link BrunoPage}, and the plugin's root route.
 *
 * A legacy `RouteRef` — a distinct type from the new system's, which is why it
 * is declared here rather than shared with `src/extensions.tsx`. An adopter
 * binds it by placing `<BrunoPage />` in the app element tree, and can then
 * resolve the dashboard's real path with `useRouteRef(brunoPlugin.routes.root)`
 * — which is what {@link BrunoCard}'s `brunoPagePath` prop wants.
 */
export const rootRouteRef = createRouteRef({ id: 'bruno' });

/**
 * The Bruno plugin for the legacy frontend system.
 *
 * `apis` registers {@link brunoApiRef} exactly as `src/api/extension.ts` does
 * for the new system: `fetchApi` rather than `window.fetch`, because the
 * backend's routes require a Backstage identity token.
 */
export const brunoPlugin = createPlugin({
  id: 'bruno',
  apis: [
    createApiFactory({
      api: brunoApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: ({ discoveryApi, fetchApi }) =>
        new BrunoClient({ discoveryApi, fetchApi })
    })
  ],
  routes: {
    root: rootRouteRef
  }
});

/**
 * The Bruno Collections dashboard, for a `<Route path="/bruno" ...>` of the
 * app's choosing.
 *
 * Content only — the legacy app supplies the page chrome. The `Add Bruno
 * Collection` action is NOT part of it: in the new system that button is a
 * plugin-scoped header action living in the `PageLayout` header, and the legacy
 * page has no such slot. Composing it into this component instead would change
 * the dashboard for both systems.
 *
 * `createRoutableExtension`'s `component` is a bare `() => Promise<T>`, not the
 * `{ lazy }` `ComponentLoader` that `createComponentExtension` takes — verified
 * against @backstage/core-plugin-api@1.12.8 `dist/index.d.ts`.
 */
export const BrunoPage = brunoPlugin.provide(
  createRoutableExtension({
    name: 'BrunoPage',
    mountPoint: rootRouteRef,
    component: () =>
      import('./components/BrunoPage').then((m) => m.BrunoPage)
  })
);

/**
 * Card for an **API** entity page: the Bruno collections that document it.
 *
 * Takes an optional `brunoPagePath`, which drives the "Add a new Bruno
 * Collection" escape hatch in the link dialog. Pass
 * `useRouteRef(brunoPlugin.routes.root)()` where {@link BrunoPage} is mounted;
 * leaving it out disables that one button and nothing else.
 */
export const BrunoCard = brunoPlugin.provide(
  createComponentExtension({
    name: 'BrunoCard',
    component: {
      lazy: () => import('./components/BrunoCard').then((m) => m.BrunoCard)
    }
  })
);

/**
 * `kind: Bruno` Overview card: the API entities this collection is `partOf`,
 * with the per-row Unlink action.
 *
 * The three `kind: Bruno` cards below import their modules directly rather than
 * through `./components/BrunoEntity`, because that barrel also re-exports
 * `BrunoEntityHeader` — which is the one component this entry point cannot
 * carry.
 */
export const RelatedApisCard = brunoPlugin.provide(
  createComponentExtension({
    name: 'RelatedApisCard',
    component: {
      lazy: () =>
        import('./components/BrunoEntity/RelatedApisCard').then(
          (m) => m.RelatedApisCard
        )
    }
  })
);

/** `kind: Bruno` Overview card: the collection's `spec.environments`. */
export const EnvironmentsCard = brunoPlugin.provide(
  createComponentExtension({
    name: 'EnvironmentsCard',
    component: {
      lazy: () =>
        import('./components/BrunoEntity/EnvironmentsCard').then(
          (m) => m.EnvironmentsCard
        )
    }
  })
);

/** `kind: Bruno` Overview card: the collection's own documentation. */
export const CollectionDocsCard = brunoPlugin.provide(
  createComponentExtension({
    name: 'CollectionDocsCard',
    component: {
      lazy: () =>
        import('./components/BrunoEntity/CollectionDocsCard').then(
          (m) => m.CollectionDocsCard
        )
    }
  })
);

/**
 * `kind: Bruno` tab content: the OpenCollection document on `spec.definition`,
 * rendered as API docs. Belongs in an `<EntityLayout.Route path="/api-docs">`.
 */
export const BrunoApiDocsContent = brunoPlugin.provide(
  createComponentExtension({
    name: 'BrunoApiDocsContent',
    component: {
      lazy: () =>
        import('./components/BrunoEntity/BrunoApiDocsContent').then(
          (m) => m.BrunoApiDocsContent
        )
    }
  })
);

export default brunoPlugin;
