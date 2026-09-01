import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Header } from '@backstage/ui';
import type { HeaderMetadataItem } from '@backstage/ui';
import CircularProgress from '@material-ui/core/CircularProgress';
import IconButton from '@material-ui/core/IconButton';
import Menu from '@material-ui/core/Menu';
import MenuItem from '@material-ui/core/MenuItem';
import Tooltip from '@material-ui/core/Tooltip';
import Button from '@material-ui/core/Button';
import { makeStyles } from '@material-ui/core/styles';
import MoreVertIcon from '@material-ui/icons/MoreVert';
import SyncIcon from '@material-ui/icons/Sync';
import { Link, LinkButton } from '@backstage/core-components';
import { alertApiRef, useApi } from '@backstage/core-plugin-api';
import {
  ANNOTATION_LOCATION,
  RELATION_OWNED_BY,
  RELATION_PART_OF,
  stringifyEntityRef
} from '@backstage/catalog-model';
import {
  EntityRefLinks,
  FavoriteEntity,
  UnregisterEntityDialog,
  catalogApiRef,
  getEntityRelations,
  useAsyncEntity,
  useEntityPresentation,
  useEntityRefLink
} from '@backstage/plugin-catalog-react';
import type { EntityHeaderLayoutProps } from '@backstage/plugin-catalog-react/alpha';
import { useEntityPermission } from '@backstage/plugin-catalog-react/alpha';
import {
  catalogEntityDeletePermission,
  catalogEntityRefreshPermission
} from '@backstage/plugin-catalog-common/alpha';
import { buildBrunoDeepLink } from '../../lib/brunoLink';
import { brunoSpec, sourceUrl, version } from '../../lib/brunoEntity';
import { elideCollectionUrl } from '../../lib/scmUrl';

const useStyles = makeStyles((theme) => ({
  // The BUI header lays `customActions` out in a row; these are MUI v4
  // controls, so they need their own alignment rather than inheriting BUI's.
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1)
  },
  danger: {
    color: theme.palette.error.main
  }
}));

/**
 * The entity-page header for `kind: Bruno`.
 *
 * A custom header layout REPLACES the stock one wholesale: `EntityLayoutBui`
 * renders `HeaderComponent` instead of `EntityHeaderBui`, and the props it is
 * handed are only `{ tabs, activeTabId }` — the collected context-menu items are
 * passed to the stock header and nowhere else, and `EntityContextMenu` is not
 * exported from `@backstage/plugin-catalog`. So everything the stock header
 * gives for free (the star, the overflow menu) has to be rebuilt here from
 * public parts, and a third-party `EntityContextMenuItemBlueprint` item will not
 * appear on Bruno pages. That cost buys the two things the stock header cannot
 * express and the PRD requires: a Version and a Source row in the title area,
 * and the collection's own action buttons next to the title.
 *
 * Everything else is deliberately parity with `EntityHeaderBui`: the same
 * `useEntityPresentation` title, the same `[kind, spec.type]` tags, the same
 * owner and part-of metadata rows.
 *
 * Inspect is wired the way the stock menu item wires it — `setSearchParams`
 * with an `inspect` key — because `EntityLayoutBui` already mounts an
 * `InspectEntityDialog` host driven by that query param. Rendering our own
 * dialog would put two of them on the page.
 */
export function BrunoEntityHeader(props: EntityHeaderLayoutProps): JSX.Element {
  const classes = useStyles();
  const { entity } = useAsyncEntity();
  const catalogApi = useApi(catalogApiRef);
  const alertApi = useApi(alertApiRef);
  const entityLink = useEntityRefLink();
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const presentation = useEntityPresentation(
    entity ?? { kind: 'Bruno', namespace: 'default', name: 'unknown' }
  );
  const refreshPermission = useEntityPermission(catalogEntityRefreshPermission);
  const deletePermission = useEntityPermission(catalogEntityDeletePermission);

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [unregisterOpen, setUnregisterOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // `HeaderComponent` is only rendered once the entity has resolved
  // (pages.esm.js picks a header layout by running its filter over the entity),
  // so this is defensive rather than a real state — but the hooks above must run
  // unconditionally, hence the late return.
  if (!entity) {
    return <Header title={presentation.primaryTitle} />;
  }

  const entityRef = stringifyEntityRef(entity);
  const spec = brunoSpec(entity);
  const url = sourceUrl(entity);
  const location = entity.metadata.annotations?.[ANNOTATION_LOCATION];
  // The same gate the stock About card applies to its Refresh action: only a
  // location the catalog can re-read is refreshable.
  const locationRefreshable = Boolean(
    location?.startsWith('url:') || location?.startsWith('file:')
  );

  const ownerRefs = getEntityRelations(entity, RELATION_OWNED_BY);
  const partOfRelations = getEntityRelations(entity, RELATION_PART_OF);

  const metadata: HeaderMetadataItem[] = [];
  if (ownerRefs.length > 0) {
    metadata.push({
      label: 'Owner',
      value: <EntityRefLinks entityRefs={ownerRefs} defaultKind="group" />
    });
  }
  if (partOfRelations.length > 0) {
    metadata.push({
      label: 'Part of',
      value: <EntityRefLinks entityRefs={partOfRelations} defaultKind="api" />
    });
  }
  metadata.push({ label: 'Version', value: version(entity) ?? '—' });
  metadata.push({
    label: 'Source',
    value: url
      ? (
          <Link to={url} target="_blank" rel="noopener noreferrer" title={url}>
            {elideCollectionUrl(url)}
          </Link>
        )
      : '—'
  });

  const onSync = async (): Promise<void> => {
    setSyncing(true);
    try {
      await catalogApi.refreshEntity(entityRef);
      alertApi.post({
        // Deliberately not "Synced". `refreshEntity` marks the entity for
        // reprocessing; the collection itself is re-read from its repository on
        // the next probe, within `bruno.cacheTtlSeconds`. Saying "Synced" would
        // promise content that is not there yet.
        message:
          'Sync requested — new collection content appears within a minute.',
        severity: 'success',
        display: 'transient'
      });
    } catch (e) {
      alertApi.post({
        message: `Sync failed: ${e instanceof Error ? e.message : String(e)}`,
        severity: 'error'
      });
    } finally {
      setSyncing(false);
    }
  };

  const fetchInBruno = url
    ? (
        <LinkButton
          size="small"
          variant="outlined"
          to={buildBrunoDeepLink(url)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Fetch in Bruno
        </LinkButton>
      )
    : (
        <Tooltip title="This collection has no source URL to open in Bruno.">
          {/* A disabled button fires no mouse events, so the tooltip needs a
              wrapper that does. */}
          <span>
            <Button size="small" variant="outlined" disabled>
              Fetch in Bruno
            </Button>
          </span>
        </Tooltip>
      );

  return (
    <>
      <Header
        title={presentation.primaryTitle}
        tags={[
          { label: entity.kind },
          ...(spec.type ? [{ label: String(spec.type) }] : [])
        ]}
        metadata={metadata}
        tabs={props.tabs}
        activeTabId={props.activeTabId}
        customActions={(
          <span className={classes.actions}>
            {fetchInBruno}
            <LinkButton
              size="small"
              variant="outlined"
              to={`${entityLink(entity)}/api-docs`}
            >
              View collection docs
            </LinkButton>
            <Button
              size="small"
              variant="outlined"
              disabled={
                syncing || !locationRefreshable || !refreshPermission.allowed
              }
              startIcon={
                syncing ? <CircularProgress size={16} /> : <SyncIcon />
              }
              onClick={() => {
                void onSync();
              }}
            >
              Sync
            </Button>
            <FavoriteEntity entity={entity} size="small" />
            <IconButton
              size="small"
              aria-label="More entity actions"
              onClick={(event) => setMenuAnchor(event.currentTarget)}
            >
              <MoreVertIcon fontSize="small" />
            </IconButton>
            <Menu
              anchorEl={menuAnchor}
              open={Boolean(menuAnchor)}
              onClose={() => setMenuAnchor(null)}
            >
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  setSearchParams('inspect');
                }}
              >
                Inspect entity
              </MenuItem>
              <MenuItem
                className={classes.danger}
                disabled={!deletePermission.allowed}
                onClick={() => {
                  setMenuAnchor(null);
                  setUnregisterOpen(true);
                }}
              >
                Unregister entity
              </MenuItem>
            </Menu>
          </span>
        )}
      />
      <UnregisterEntityDialog
        open={unregisterOpen}
        entity={entity}
        onClose={() => setUnregisterOpen(false)}
        onConfirm={() => {
          setUnregisterOpen(false);
          navigate('/catalog');
        }}
      />
    </>
  );
}
