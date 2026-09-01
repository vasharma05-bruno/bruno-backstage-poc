import { useMemo, useState } from 'react';
import Box from '@material-ui/core/Box';
import DeleteOutlineIcon from '@material-ui/icons/DeleteOutline';
import { Content, ContentHeader, Link, SupportButton } from '@backstage/core-components';
import type { TableColumn, TableProps } from '@backstage/core-components';
import type { Entity } from '@backstage/catalog-model';
import { CatalogTable } from '@backstage/plugin-catalog';
import type { CatalogTableRow } from '@backstage/plugin-catalog';
import {
  CatalogFilterLayout,
  EntityKindPicker,
  EntityListProvider,
  EntityOwnerPicker,
  EntityRefLinks,
  EntityTagPicker,
  EntityTypePicker,
  UserListPicker,
  useEntityList
} from '@backstage/plugin-catalog-react';
import {
  collectionOrigin,
  environments,
  partOfRefs,
  requestCount,
  sourceUrl,
  version
} from '../../lib/brunoEntity';
import { elideCollectionUrl } from '../../lib/scmUrl';
import { DeleteCollectionDialog } from './DeleteCollectionDialog';
import { PendingCollections } from './PendingCollections';
import { StatTiles } from './StatTiles';
import type { StatTile } from './StatTiles';

/**
 * The catalog kind this page lists.
 *
 * Lower-cased to match how `EntityKindPicker`/`EntityKindFilter` handle it —
 * the picker lower-cases before looking the kind up in the catalog's kind
 * facets, and the filter compares case-insensitively.
 */
const BRUNO_KIND = 'bruno';

/**
 * `metadata.version` — not a schema-recognised `EntityMeta` field, so no stock
 * column factory covers it. `field` is the dot path `Table` sorts and searches
 * on; `render` goes through `version()` so a numeric YAML version (`1.2`) is
 * shown as written rather than as a JS number.
 */
function createVersionColumn(): TableColumn<CatalogTableRow> {
  return {
    title: 'Version',
    field: 'entity.metadata.version',
    width: 'auto',
    render: ({ entity }) => version(entity) ?? ''
  };
}

/**
 * `spec.url` — the collection folder in source control, as an external link.
 *
 * `customFilterAndSearch` searches the FULL url while the cell shows the elided
 * one: a user pasting a repo path into the search box is matching against what
 * they have, not against what we chose to display.
 */
function createSourceColumn(): TableColumn<CatalogTableRow> {
  return {
    title: 'Source',
    field: 'entity.spec.url',
    width: 'auto',
    customFilterAndSearch: (query, row) =>
      (sourceUrl(row.entity) ?? '')
        .toLocaleUpperCase('en-US')
        .includes(query.toLocaleUpperCase('en-US')),
    render: ({ entity }) => {
      const url = sourceUrl(entity);
      if (!url) {
        return null;
      }
      return (
        <Link to={url} target="_blank" rel="noopener noreferrer" title={url}>
          {elideCollectionUrl(url)}
        </Link>
      );
    }
  };
}

/**
 * The API entities each collection is `partOf`, as catalog links.
 *
 * Read from `spec.partOf` rather than from the `partOf` RELATION: relations are
 * stitched a processing cycle after the entity is registered, so a
 * relation-backed column renders empty for minutes on a freshly-registered
 * collection — which reads as "the link did not take". `spec.partOf` is on the
 * entity the moment the catalog has it.
 */
function createRelatedApisColumn(): TableColumn<CatalogTableRow> {
  return {
    title: 'Related APIs',
    field: 'entity.spec.partOf',
    width: 'auto',
    customFilterAndSearch: (query, row) =>
      partOfRefs(row.entity)
        .join(', ')
        .toLocaleUpperCase('en-US')
        .includes(query.toLocaleUpperCase('en-US')),
    render: ({ entity }) => {
      const refs = partOfRefs(entity);
      if (refs.length === 0) {
        return null;
      }
      return <EntityRefLinks entityRefs={refs} defaultKind="api" />;
    }
  };
}

/**
 * The dashboard's columns.
 *
 * Stock `CatalogTable.columns` factories wherever one fits, so name resolution,
 * owner relations, description overflow and tag chips behave exactly as they do
 * on every other catalog page. Only the three Bruno-specific fields
 * (`metadata.version`, `spec.url`, `spec.partOf`) need bespoke cells.
 *
 * The title column is hidden-but-present for the same reason the API explorer
 * keeps it: `metadata.title` is searchable through it even though the name
 * column is what gets displayed.
 */
const columns: TableColumn<CatalogTableRow>[] = [
  CatalogTable.columns.createTitleColumn({ hidden: true }),
  CatalogTable.columns.createNameColumn({ defaultKind: 'Bruno' }),
  createVersionColumn(),
  createSourceColumn(),
  CatalogTable.columns.createOwnerColumn(),
  createRelatedApisColumn(),
  CatalogTable.columns.createMetadataDescriptionColumn(),
  CatalogTable.columns.createTagsColumn()
];

/**
 * The three PRD figures, derived from the Bruno entities the list context has
 * loaded.
 *
 * Derived from `entities` (post-filter) rather than `backendEntities`, so the
 * figures describe what the table below is actually showing — filter to one
 * owner and the counts follow. With the default `paginationMode: 'none'` that
 * is the whole result set, not a page of it.
 *
 * Every field is read defensively. `spec.requestCount` and `spec.environments`
 * are written by `BrunoKindProcessor` a processing cycle AFTER the entity first
 * appears, so a freshly-registered collection legitimately has neither; a
 * missing count contributes 0 and a missing environment list contributes
 * nothing to the distinct set, rather than throwing or rendering `NaN`.
 *
 * Deliberately not `catalogApi.getEntityFacets`: a second round trip would drift
 * out of step with the filters applied here, and the numbers are already on the
 * entities in hand.
 */
function useBrunoStats(entities: Entity[]): StatTile[] {
  return useMemo(() => {
    let requests = 0;
    const distinctEnvironments = new Set<string>();
    for (const entity of entities) {
      requests += requestCount(entity) ?? 0;
      for (const env of environments(entity)) {
        distinctEnvironments.add(env);
      }
    }
    return [
      {
        label: 'Collections',
        value: entities.length,
        hint: 'Bruno collection entities in the catalog matching the current filters.'
      },
      {
        label: 'Requests',
        value: requests,
        hint: 'Total executable requests across those collections. Collections that have not been processed yet count as 0.'
      },
      {
        label: 'Environments',
        value: distinctEnvironments.size,
        hint: 'Distinct environment names across those collections.'
      }
    ];
  }, [entities]);
}

/**
 * The stat tiles, as their own component so they can sit INSIDE the
 * `EntityListProvider` and read the same filtered entity list the table renders
 * — a tile row rendered outside the provider would have to fetch its own copy.
 */
function BrunoStatTiles(): JSX.Element {
  const { entities, loading } = useEntityList();
  const tiles = useBrunoStats(entities);
  // While the first fetch is in flight `entities` is legitimately empty, and
  // three confident zeroes read as "you have no collections" rather than as
  // "not counted yet". An em dash says the second thing.
  const shown = loading
    ? tiles.map((tile) => ({ ...tile, value: '—' }))
    : tiles;
  return <StatTiles tiles={shown} />;
}

/**
 * The collections table, plus the remove affordance on the rows that have one.
 *
 * Its own component for the same reason `BrunoStatTiles` is: the action's
 * `onClick` has to put an entity into component state so the confirmation
 * dialog can be rendered for it, and `BrunoPage` below is a stateless
 * composition of providers.
 *
 * The gate is `collectionOrigin(entity) === 'ui'` and nothing else. That
 * accessor reads the `usebruno.com/origin` annotation the provider stamps, and
 * it CANNOT return `'ui'` from its own location-annotation fallback — a UI
 * collection and a committed descriptor are the same file shape, which is the
 * ambiguity the annotation was added to resolve. So an entity that has not been
 * processed yet, or was ingested by an older backend, has no delete button
 * rather than a button that fails. Re-deriving the origin from
 * `backstage.io/managed-by-location` here would be a second, worse answer to a
 * question `lib/brunoEntity.ts` already answers for `changeRoute` too.
 *
 * `hidden` rather than `disabled`: a disabled icon on every config-origin row
 * is a permanent piece of furniture that means nothing to the operator who put
 * those rows in `app-config.yaml`, and the reason it is disabled has nowhere to
 * live in a table cell.
 */
function BrunoCollectionsTable(): JSX.Element {
  const [pending, setPending] = useState<Entity | undefined>();

  // Memoised for the same reason `columns` is a module constant: `CatalogTable`
  // hands this array to material-table, which treats a new `actions` identity
  // as a reason to rebuild the actions column on every render — and this
  // component re-renders on every entity-list change underneath it. `setPending`
  // is a stable setter, so there is nothing for the array to depend on.
  const actions = useMemo<TableProps<CatalogTableRow>['actions']>(
    () => [
      (row) => ({
        icon: () => <DeleteOutlineIcon fontSize="small" />,
        tooltip: 'Remove this collection',
        hidden: collectionOrigin(row.entity) !== 'ui',
        onClick: () => setPending(row.entity)
      })
    ],
    []
  );

  return (
    <>
      {/*
        An explicit title, because the generated one would read "All brunos":
        it is built as `<user filter> <type> <pluralize(kind label)>`, and
        `pluralize('Bruno')` has no idea our kind is a collection.
      */}
      <CatalogTable columns={columns} actions={actions} title="Collections" />
      {pending && (
        <DeleteCollectionDialog
          open
          entity={pending}
          onClose={() => setPending(undefined)}
        />
      )}
    </>
  );
}

/**
 * The Bruno Collections dashboard, at `/bruno`.
 *
 * A direct mirror of `DefaultApiExplorerPage`
 * (node_modules/@backstage/plugin-api-docs/dist/components/ApiExplorerPage/
 * DefaultApiExplorerPage.esm.js): `EntityListProvider` owns fetching and filter
 * state, `CatalogFilterLayout` splits the stock pickers from the content, and
 * `CatalogTable` renders the rows. Nothing here fetches, filters or paginates by
 * hand — the point of the rewrite is that a Bruno collection is now an ordinary
 * catalog entity and gets the catalog's own machinery for free (URL-synced
 * filters, owned/starred, tag facets, search, sorting, CSV export).
 *
 * Content-only: the PageLayout supplies the app header, so there is no
 * `<Page>`/`<Header>` here. `ContentHeader` carries the dashboard's own title.
 *
 * The kind picker is `hidden` with `initialFilter={BRUNO_KIND}`, exactly as the
 * API explorer pins itself to `api` — the filter still lands in the query string
 * and in the backend request, it just is not user-changeable on a page that
 * exists to show one kind.
 *
 * No lifecycle picker: `kind: Bruno` has no `spec.lifecycle`, so the picker
 * would render an empty facet list on every load.
 */
export function BrunoPage(): JSX.Element {
  return (
    <Content>
      <ContentHeader title="Bruno Collections">
        <SupportButton>
          The Bruno collections registered in the catalog. Each row is a Bruno
          entity — open one for its documentation, environments and related APIs.
        </SupportButton>
      </ContentHeader>
      {/*
        Both the tiles and the table live inside the provider: the tiles derive
        their figures from the same filtered entity list the table renders, and
        `useEntityList` throws outside it.
      */}
      <EntityListProvider>
        <Box mb={2}>
          <BrunoStatTiles />
        </Box>
        <CatalogFilterLayout>
          <CatalogFilterLayout.Filters>
            <EntityKindPicker initialFilter={BRUNO_KIND} hidden />
            <EntityTypePicker />
            <UserListPicker initialFilter="all" />
            <EntityOwnerPicker />
            <EntityTagPicker />
          </CatalogFilterLayout.Filters>
          <CatalogFilterLayout.Content>
            {/*
              Above the table and inside the provider, because it reports on
              collections the table CANNOT show yet — they are stored but not
              catalogued — and because it calls `useEntityList().refresh` when
              one of them lands, which is what makes the table pick it up. It
              renders nothing at all when there is nothing outstanding.
            */}
            <PendingCollections />
            <BrunoCollectionsTable />
          </CatalogFilterLayout.Content>
        </CatalogFilterLayout>
      </EntityListProvider>
    </Content>
  );
}
