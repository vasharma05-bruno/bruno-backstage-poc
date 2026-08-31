import type { Entity } from '@backstage/catalog-model';
import {
  EntityCardBlueprint,
  EntityContentBlueprint,
  EntityHeaderLayoutBlueprint
} from '@backstage/plugin-catalog-react/alpha';
import {
  PageBlueprint,
  createRouteRef
} from '@backstage/frontend-plugin-api';
import { BrunoIcon } from './components/BrunoLogo';

/**
 * Filter selecting any API entity — the surface `BrunoCard` hangs off.
 *
 * Deliberately NOT gated on a `bruno.dev/*` annotation or on the presence of a
 * `hasPart` relation: catalog processing stamps relations a cycle (minutes)
 * after a Bruno entity is registered, so an annotation/relation-gated card is
 * missing exactly when the user has just linked a collection and goes looking
 * for it. The card resolves its collections at render time and renders its own
 * empty state when there are none.
 *
 * Predicate-function form (the blueprint filter accepts
 * `string | FilterPredicate | ((entity: Entity) => boolean)`) to avoid coupling
 * to the exact FilterPredicate object shape across versions.
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
 * Route ref for the standalone Bruno page. Setting `routeRef` + `title` + `icon`
 * on the PageBlueprint below is what makes the nav item appear: the custom
 * Sidebar renders `nav.rest({ sortBy: 'title' })`, which auto-discovers pages
 * carrying all three. No NavItemBlueprint (absent in 1.53) and no
 * `packages/app` edit are needed.
 *
 * Exported so components can resolve the dashboard's path through `useRouteRef`
 * — the "Add a new Bruno Collection" button in the link dialog — rather than
 * hardcoding `/bruno`, which the app is free to mount elsewhere.
 */
export const brunoPageRouteRef = createRouteRef();

/**
 * Standalone Bruno page at `/bruno`. The component renders content only (the
 * PageLayout supplies the header). The icon is the Bruno mark, so the sidebar
 * entry and the page header both carry the brand; it is an `SvgIcon`, so
 * `fontSize="inherit"` sizes it exactly like the stock Material-UI icons around
 * it.
 */
export const brunoPage = PageBlueprint.make({
  name: 'bruno',
  params: {
    path: '/bruno',
    title: 'Bruno',
    icon: <BrunoIcon fontSize="inherit" />,
    routeRef: brunoPageRouteRef,
    loader: () =>
      import('./components/BrunoPage').then((m) => <m.BrunoPage />)
  }
});

/**
 * Route ref for the standalone full-screen docs page. Declares the
 * `namespace`/`name` path parameters so `useRouteRefParams` can read them. No
 * `title`/`icon` (so it stays out of the sidebar) and `noHeader` so the page
 * renders chrome-less.
 *
 * Keyed by entity ref rather than by a backend collection id: collection-id
 * keying was the annotation model's notion of identity, and the collection is
 * now an entity whose generated OpenCollection document travels on it.
 */
export const brunoDocsPageRouteRef = createRouteRef({
  params: ['namespace', 'name']
});

/**
 * Standalone, chrome-less full-viewport API-docs page at
 * `/bruno/docs/:namespace/:name`, opened in a new tab from the Bruno entity's
 * "Bruno API Docs" tab. Deliberately has no `title`/`icon` (kept out of the
 * auto-discovered sidebar) and `noHeader: true` so only the full-screen docs
 * iframe shows.
 */
export const brunoDocsPage = PageBlueprint.make({
  name: 'docs-page',
  params: {
    path: '/bruno/docs/:namespace/:name',
    routeRef: brunoDocsPageRouteRef,
    noHeader: true,
    loader: () =>
      import('./components/BrunoDocsPage').then((m) => <m.BrunoDocsPage />)
  }
});

/**
 * Everything below targets `kind: Bruno` — the collection as a first-class
 * catalog entity.
 *
 * The filter is the `FilterPredicate` OBJECT form (`{ kind: 'bruno' }`) rather
 * than the predicate-function form the API-entity extensions above use:
 * `EntityHeaderLayoutBlueprint` accepts no string form at all, and only the
 * object form can be overridden from `app-config.yaml`. Using it uniformly
 * across the five extensions keeps them overridable as a set.
 */
const isBrunoEntityFilter = { kind: 'bruno' };

/**
 * Replaces the whole entity header on Bruno pages, so the title area can carry
 * the collection's version, its source URL and its own actions — none of which
 * the stock header has a slot for. See `BrunoEntityHeader` for what that costs
 * (the star and the overflow menu have to be rebuilt) and why it is worth it.
 *
 * Note that `loader` here resolves to a COMPONENT, not an element: the layout is
 * handed `{ tabs, activeTabId }` by `EntityLayoutBui`.
 */
export const brunoEntityHeader = EntityHeaderLayoutBlueprint.make({
  name: 'header',
  params: {
    filter: isBrunoEntityFilter,
    loader: () =>
      import('./components/BrunoEntity').then((m) => m.BrunoEntityHeader)
  }
});

/**
 * Overview card rendering the collection's own documentation, read from the
 * OpenCollection document on `spec.definition` (falling back to
 * `metadata.description`). `type: 'content'` puts it in the wide left column
 * with the other substantial cards rather than in the narrow info column.
 */
export const brunoDocumentationCard = EntityCardBlueprint.make({
  name: 'documentation',
  params: {
    filter: isBrunoEntityFilter,
    type: 'content',
    loader: () =>
      import('./components/BrunoEntity').then((m) => <m.CollectionDocsCard />)
  }
});

/**
 * Overview card listing the API entities this collection is `partOf`, with the
 * per-row Unlink action.
 */
export const brunoRelatedApisCard = EntityCardBlueprint.make({
  name: 'related-apis',
  params: {
    filter: isBrunoEntityFilter,
    type: 'content',
    loader: () =>
      import('./components/BrunoEntity').then((m) => <m.RelatedApisCard />)
  }
});

/** Overview card listing the collection's environments, from `spec.environments`. */
export const brunoEnvironmentsCard = EntityCardBlueprint.make({
  name: 'environments',
  params: {
    filter: isBrunoEntityFilter,
    type: 'content',
    loader: () =>
      import('./components/BrunoEntity').then((m) => <m.EnvironmentsCard />)
  }
});

/**
 * The Bruno entity's second and only other tab, at
 * `/catalog/<ns>/bruno/<name>/api-docs`.
 *
 * Ungrouped on purpose: a `group` would fold it into one of the entity page's
 * tab dropdowns instead of giving it a tab of its own. Together with the stock,
 * unfiltered Overview content that makes exactly two tabs.
 */
export const brunoApiDocsContent = EntityContentBlueprint.make({
  name: 'api-docs',
  params: {
    path: '/api-docs',
    title: 'Bruno API Docs',
    icon: <BrunoIcon fontSize="inherit" />,
    filter: isBrunoEntityFilter,
    loader: () =>
      import('./components/BrunoEntity').then((m) => <m.BrunoApiDocsContent />)
  }
});
