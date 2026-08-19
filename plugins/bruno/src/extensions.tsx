import type { Entity } from '@backstage/catalog-model';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';
import {
  PageBlueprint,
  createRouteRef
} from '@backstage/frontend-plugin-api';
import Http from '@material-ui/icons/Http';

/**
 * Filter selecting any API entity. Used as the card/content filter so
 * runtime-connected (non-annotated) API entities also get the Bruno card and
 * docs tab; the components themselves render a connect prompt when no
 * collection is linked. We use a predicate function form (the blueprint filter
 * accepts `string | FilterPredicate | ((entity: Entity) => boolean)`) to avoid
 * coupling to the exact FilterPredicate object shape across versions.
 */
const isApiEntity = (entity: Entity): boolean =>
  entity.kind.toLocaleLowerCase('en-US') === 'api';

/**
 * Entity card. Signature verified against
 * @backstage/plugin-catalog-react@3.2.0 (mirrors `apiDocsDefinitionEntityCard`
 * in node_modules/@backstage/plugin-api-docs/dist/alpha.esm.js):
 *   EntityCardBlueprint.make({ name, params: { filter, loader } })
 * where `loader: () => Promise<JSX.Element>`.
 */
export const brunoCard = EntityCardBlueprint.make({
  name: 'collection',
  params: {
    filter: isApiEntity,
    loader: () =>
      import('./components/BrunoCard').then((m) => <m.BrunoCard />)
  }
});

/**
 * Right-column entity card rendering a compact, read-only tree of the linked
 * Bruno collection. Same `isApiEntity` filter as `brunoCard`; the component
 * renders nothing when the entity has no linked collection.
 */
export const brunoCollectionTreeCard = EntityCardBlueprint.make({
  name: 'collection-tree',
  params: {
    filter: isApiEntity,
    loader: () =>
      import('./components/CollectionTree').then((m) => <m.CollectionTreeCard />)
  }
});

/**
 * Right-column entity card rendering the connected Bruno collection's root
 * README as markdown. Same `isApiEntity` filter as `brunoCard`; the component
 * renders nothing when the entity has no linked collection or no README.
 */
export const brunoCollectionOverviewCard = EntityCardBlueprint.make({
  name: 'collection-overview',
  params: {
    filter: isApiEntity,
    loader: () =>
      import('./components/CollectionOverview').then((m) => (
        <m.CollectionOverviewCard />
      ))
  }
});

/**
 * Route ref for the standalone Bruno page. Setting `routeRef` + `title` + `icon`
 * on the PageBlueprint below is what makes the nav item appear: the custom
 * Sidebar renders `nav.rest({ sortBy: 'title' })`, which auto-discovers pages
 * carrying all three. No NavItemBlueprint (absent in 1.53) and no
 * `packages/app` edit are needed.
 */
const brunoPageRouteRef = createRouteRef();

/**
 * Standalone Bruno page at `/bruno`. The component renders content only (the
 * PageLayout supplies the header). Icon is `Http` — `@material-ui/icons/Api` is
 * missing in this version, so importing it would break the build.
 */
export const brunoPage = PageBlueprint.make({
  name: 'bruno',
  params: {
    path: '/bruno',
    title: 'Bruno',
    icon: <Http fontSize="inherit" />,
    routeRef: brunoPageRouteRef,
    loader: () =>
      import('./components/BrunoPage').then((m) => <m.BrunoPage />)
  }
});

/**
 * Route ref for the standalone full-screen docs page. Declares the
 * `collectionId` path parameter so `useRouteRefParams` can read it. No
 * `title`/`icon` (so it stays out of the sidebar) and `noHeader` so the page
 * renders chrome-less.
 */
export const brunoDocsPageRouteRef = createRouteRef({
  params: ['collectionId']
});

/**
 * Standalone, chrome-less full-viewport API-docs page at
 * `/bruno/docs/:collectionId`, opened in a new tab as `/bruno/docs/<id>`.
 * Deliberately has no `title`/`icon` (kept out of the auto-discovered sidebar)
 * and `noHeader: true` so only the full-screen docs iframe shows.
 */
export const brunoDocsPage = PageBlueprint.make({
  name: 'docs-page',
  params: {
    path: '/bruno/docs/:collectionId',
    routeRef: brunoDocsPageRouteRef,
    noHeader: true,
    loader: () =>
      import('./components/BrunoDocsPage').then((m) => <m.BrunoDocsPage />)
  }
});
