import type { Entity } from '@backstage/catalog-model';
import {
  EntityCardBlueprint,
  EntityContentBlueprint
} from '@backstage/plugin-catalog-react/alpha';

/**
 * Filter selecting Bruno collection entities (kind: API, spec.type:
 * bruno-collection). We use a predicate function form (the blueprint filter
 * accepts `string | FilterPredicate | ((entity: Entity) => boolean)`) to avoid
 * coupling to the exact FilterPredicate object shape across versions.
 */
const isBrunoCollection = (entity: Entity): boolean =>
  entity.kind.toLocaleLowerCase('en-US') === 'api'
  && (entity.spec?.type as string | undefined) === 'bruno-collection';

/**
 * Filter selecting any API entity. Used as the card filter so runtime-connected
 * (non-annotated) API entities also get the Bruno card; the card itself renders
 * a connect prompt when no collection is linked.
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
 * Entity content tab ("API Docs"). Signature verified against
 * @backstage/plugin-catalog-react@3.2.0 (mirrors `apiDocsApisEntityContent`).
 *
 * NOTE: the installed blueprint deprecates `defaultPath`/`defaultTitle` in
 * favour of `path`/`title` (see alpha.d.ts EntityContentBlueprint.params), so
 * we use `path: '/bruno-docs'` + `title: 'API Docs'`.
 */
export const brunoDocsContent = EntityContentBlueprint.make({
  name: 'docs',
  params: {
    path: '/bruno-docs',
    title: 'API Docs',
    filter: isBrunoCollection,
    loader: () =>
      import('./components/CollectionDocs').then((m) => <m.CollectionDocs />)
  }
});
