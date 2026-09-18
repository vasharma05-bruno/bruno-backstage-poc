import type { Entity } from '@backstage/catalog-model';
import {
  EntityCardBlueprint,
  EntityContentBlueprint,
  EntityHeaderLayoutBlueprint
} from '@backstage/plugin-catalog-react/alpha';
import {
  PageBlueprint,
  PluginHeaderActionBlueprint,
  createRouteRef,
  useRouteRef
} from '@backstage/frontend-plugin-api';
import type { catalogImportPlugin } from '@backstage/plugin-catalog-import';
import { BrunoIcon } from './components/BrunoLogo';
import type { AddCollectionAction } from './components/AddCollection';
import type { BrunoCard } from './components/BrunoCard';

/**
 * Filter selecting any API entity — the surface `BrunoCard` hangs off.
 *
 * Deliberately NOT gated on a `usebruno.com/*` annotation or on the presence of a
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
 * Route ref for the standalone Bruno page. Setting `routeRef` + `title` + `icon`
 * on the PageBlueprint below is what makes the nav item appear: the custom
 * Sidebar renders `nav.rest({ sortBy: 'title' })`, which auto-discovers pages
 * carrying all three. No NavItemBlueprint (absent in 1.53) and no
 * `packages/app` edit are needed.
 *
 * Module-local. It is also what `RoutedBrunoCard` below resolves so the link
 * dialog's "Add a new Bruno Collection" button can navigate to the dashboard
 * rather than hardcode `/bruno`, which the app is free to mount elsewhere.
 */
const brunoPageRouteRef = createRouteRef();

/**
 * Route resolution for the two components that need a concrete path, done HERE
 * rather than inside them.
 *
 * `useRouteRef` is the one thing that differs irreconcilably between the two
 * frontend systems, and this file is the only part of the plugin that is
 * new-system-only. Keeping the hook here is what lets `src/legacy.ts` hand the
 * same components to a legacy app — see the module-graph guard in
 * `src/legacy.test.ts`, which is what stops this creeping back down the tree.
 *
 * Each wrapper takes the loaded component as a prop so the blueprint loaders
 * below stay dynamic `import()`s; a static import of the component here would
 * fold it into the plugin's eager chunk. The component types are pulled in with
 * `import type`, which is erased.
 */
function RoutedBrunoCard(props: {
  component: typeof BrunoCard;
}): JSX.Element {
  const Card = props.component;
  const dashboardRoute = useRouteRef(brunoPageRouteRef);
  return <Card brunoPagePath={dashboardRoute?.()} />;
}

/**
 * The catalog-import route ref is loaded alongside the action rather than
 * imported at the top of this file, so `@backstage/plugin-catalog-import` stays
 * out of the eager chunk — it was only ever reached from inside the lazily
 * loaded `GeneratedYamlDialog`.
 *
 * The ref comes off the OLD-system plugin export because the new-system
 * `/alpha` entry point does not re-export it, and they are the same object:
 * `alpha.esm.js` imports `rootRouteRef` from `plugin.esm.js` and declares it as
 * `routes.importPage`.
 */
function RoutedAddCollectionAction(props: {
  component: typeof AddCollectionAction;
  importPageRouteRef: (typeof catalogImportPlugin)['routes']['importPage'];
}): JSX.Element {
  const Action = props.component;
  const importRoute = useRouteRef(props.importPageRouteRef);
  return <Action catalogImportPath={importRoute?.()} />;
}

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
      import('./components/BrunoCard').then((m) => (
        <RoutedBrunoCard component={m.BrunoCard} />
      ))
  }
});

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
 * The `Add Bruno Collection` button in the page header, and the two modals
 * behind it.
 *
 * `PluginHeaderActionBlueprint` rather than putting the button inside
 * `BrunoPage`: the action then lives in the `PageLayout` header alongside the
 * page title, which is where Backstage's own pages put their primary actions
 * (`techDocsSupportAction` does exactly this), instead of competing with the
 * `ContentHeader` inside the content area.
 *
 * Header actions are PLUGIN-scoped, not page-scoped — `PageBlueprint` asks the
 * header-actions API for every action belonging to the page's plugin. This
 * plugin owns exactly one page, so the button appears on `/bruno` alone without
 * any filtering of our own — but a second page added here would inherit it.
 */
export const brunoAddCollectionAction = PluginHeaderActionBlueprint.make({
  name: 'add-collection',
  params: {
    loader: async () => {
      const [action, catalogImport] = await Promise.all([
        import('./components/AddCollection'),
        import('@backstage/plugin-catalog-import')
      ]);
      return (
        <RoutedAddCollectionAction
          component={action.AddCollectionAction}
          importPageRouteRef={
            catalogImport.catalogImportPlugin.routes.importPage
          }
        />
      );
    }
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
