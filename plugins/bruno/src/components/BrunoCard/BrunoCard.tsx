import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from '@material-ui/core/Button';
import Chip from '@material-ui/core/Chip';
import Divider from '@material-ui/core/Divider';
import IconButton from '@material-ui/core/IconButton';
import Menu from '@material-ui/core/Menu';
import MenuItem from '@material-ui/core/MenuItem';
import Tooltip from '@material-ui/core/Tooltip';
import Typography from '@material-ui/core/Typography';
import Box from '@material-ui/core/Box';
import MoreVertIcon from '@material-ui/icons/MoreVert';
import { makeStyles } from '@material-ui/core/styles';
import { Link, Progress, Table, WarningPanel } from '@backstage/core-components';
import type { TableColumn } from '@backstage/core-components';
import { RELATION_HAS_PART, stringifyEntityRef } from '@backstage/catalog-model';
import type { Entity } from '@backstage/catalog-model';
import {
  EntityRefLink,
  useEntity,
  useEntityRefLink,
  useRelatedEntities
} from '@backstage/plugin-catalog-react';
import { linkSource, sourceUrl, version } from '../../lib/brunoEntity';
import { useEntityRelationRefresh } from '../../lib/entityRefresh';
import { BrunoInfoCard } from '../BrunoInfoCard';
import { UnlinkDialog } from '../BrunoEntity';
import { OpenInBrunoSnackbar, useOpenInBruno } from '../OpenInBruno';
import { elideCollectionUrl } from '../../lib/scmUrl';
import { LinkCollectionDialog } from './LinkCollectionDialog';

/** Longest a source URL is shown in a table cell before the middle is elided.
 *  Tighter than the shared default: this cell is in a card, not a page. */
const MAX_SOURCE_URL_CHARS = 44;

const useStyles = makeStyles((theme) => ({
  danger: {
    color: theme.palette.error.main
  },
  empty: {
    padding: theme.spacing(2)
  },
  prStrip: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    padding: theme.spacing(1, 2, 2)
  },
  chip: {
    marginLeft: theme.spacing(1)
  }
}));

/**
 * The per-row action menu: Fetch in Bruno, View Collection Docs, Unlink.
 *
 * Its own component because each row needs its own menu anchor and its own
 * "Open in Bruno" state, and hooks cannot be called from a `render` callback
 * conditionally per row otherwise.
 */
function CollectionActions(props: {
  collection: Entity;
  onUnlink: () => void;
}): JSX.Element {
  const { collection, onUnlink } = props;
  const classes = useStyles();
  const navigate = useNavigate();
  const entityLink = useEntityRefLink();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const url = sourceUrl(collection);
  // The deep link AND its clipboard fallback, straight from `OpenInBruno` — the
  // split button cannot live inside a menu, but its behaviour can.
  const openInBruno = useOpenInBruno(url);

  const close = (): void => setAnchor(null);

  return (
    <>
      <IconButton
        size="small"
        aria-label={`Actions for ${collection.metadata.name}`}
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={close}
      >
        <MenuItem
          disabled={!url}
          onClick={() => {
            close();
            openInBruno.openDeepLink();
          }}
        >
          Fetch in Bruno
        </MenuItem>
        <MenuItem
          disabled={!url}
          onClick={() => {
            close();
            void openInBruno.copyCloneInstruction();
          }}
        >
          Clone &amp; open in Bruno (copy git clone)
        </MenuItem>
        <MenuItem
          // The collection's own entity page, `Bruno API Docs` tab — the only
          // place the OpenCollection document is rendered now that the
          // standalone `/bruno/docs/...` page is gone.
          onClick={() => {
            close();
            navigate(`${entityLink(collection)}/api-docs`);
          }}
        >
          View Collection Docs
        </MenuItem>
        <Divider />
        <MenuItem
          className={classes.danger}
          onClick={() => {
            close();
            onUnlink();
          }}
        >
          Unlink
        </MenuItem>
      </Menu>
      {/* Outside the Menu: a Snackbar child would be cloned into the menu's
          keyboard-navigable item list. */}
      <OpenInBrunoSnackbar actions={openInBruno} />
    </>
  );
}

/**
 * Entity card for an API entity: the Bruno collections that document it.
 *
 * Reads the catalog RELATION (`hasPart` → `kind: Bruno`), which
 * `BrunoKindProcessor` emits as the mirror of each collection's `partOf` —
 * whether that `partOf` is a `spec.partOf` entry in source control or a runtime
 * link in the `bruno` backend's own table. The relation is identical either
 * way, which is why the table needs no branch: the only place the difference
 * shows is the per-row chip, and the Unlink dialog, which has to remove them by
 * completely different means.
 *
 * Deliberately NOT gated on any `usebruno.com/*` annotation for VISIBILITY: the
 * catalog stamps those on its own processing schedule, minutes after an entity
 * is registered, so an annotation-gated card reads as empty exactly when a user
 * has just wired something up and is looking at it. (The runtime-link chip does
 * read an annotation, but it decorates a row the relation already put there.)
 *
 * Built on core-components `Table` rather than `EntityRelationCard` for the same
 * reason `RelatedApisCard` is: the latter has no per-row action slot, and its
 * cells must be `@backstage/ui` components, which would put a second design
 * system inside a Material-UI v4 card.
 */
export function BrunoCard(): JSX.Element {
  const classes = useStyles();
  const { entity } = useEntity();
  const { entities, loading, error } = useRelatedEntities(entity, {
    type: RELATION_HAS_PART,
    kind: 'Bruno'
  });
  // Re-reads THIS API entity after a runtime link change, which is what makes
  // the relation above appear: `useRelatedEntities` derives its list from the
  // relations on the entity object, so nothing moves until the entity is
  // fetched again.
  const refreshRelations = useEntityRelationRefresh();

  const apiRef = stringifyEntityRef(entity);

  const [linkOpen, setLinkOpen] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<Entity | undefined>();
  /**
   * Open unlink pull requests from this session, keyed by Bruno entity ref.
   *
   * Session state on purpose. Persisting it would mean a side store of
   * pull-request state, and a pull request already lives somewhere better — the
   * SCM host — so after a reload the chip is gone and the link is wherever the
   * review left it.
   */
  const [unlinkPrs, setUnlinkPrs] = useState<Record<string, string>>({});
  /**
   * Link pull requests, as `[label, url]`. Kept separately from `unlinkPrs`
   * because a linked collection is NOT in the table yet — the relation only
   * exists once the pull request is merged and the descriptor re-read — so there
   * is no row to hang a chip on.
   */
  const [linkPrs, setLinkPrs] = useState<{ label: string; link: string }[]>([]);
  /**
   * Collections linked at RUNTIME in this session, by ref.
   *
   * Also session state, and for a different reason from the pull requests: this
   * change has already happened and is seconds from being visible, so the chip
   * is a progress indicator rather than a record. It is dropped as soon as the
   * collection turns up in `entities` below, which is the event it exists to
   * cover.
   */
  const [runtimeLinked, setRuntimeLinked] = useState<string[]>([]);
  /** Refs whose runtime link was just removed — same idea, other direction. */
  const [runtimeUnlinked, setRuntimeUnlinked] = useState<string[]>([]);

  const listed = new Set((entities ?? []).map((e) => stringifyEntityRef(e)));
  const pendingLinks = runtimeLinked.filter((ref) => !listed.has(ref));

  const columns: TableColumn<Entity>[] = [
    {
      title: 'Name',
      field: 'metadata.name',
      render: (row) => {
        const ref = stringifyEntityRef(row);
        // Which of the two places this link is recorded in. Worth a chip
        // because it decides what Unlink will do — one click, or a pull
        // request — and because a link that lives only in this instance is a
        // thing an operator should be able to spot at a glance.
        const source = linkSource(row, apiRef);
        return (
          <>
            <EntityRefLink entityRef={row} defaultKind="bruno" />
            {(source === 'runtime' || source === 'both') && (
              <Tooltip
                title={
                  source === 'both'
                    ? 'Linked both in this Backstage instance and in the '
                    + 'collection\'s spec.partOf. Removing the relation takes '
                    + 'both.'
                    : 'Linked in this Backstage instance only. Nothing in '
                      + 'source control records this link.'
                }
              >
                <Chip
                  size="small"
                  variant="outlined"
                  className={classes.chip}
                  label={source === 'both' ? 'Runtime + descriptor' : 'Runtime link'}
                />
              </Tooltip>
            )}
            {runtimeUnlinked.includes(ref) && (
              <Chip
                size="small"
                className={classes.chip}
                label="Unlinking…"
              />
            )}
            {unlinkPrs[ref] && (
              <Chip
                size="small"
                className={classes.chip}
                label="Unlink PR open"
                component="a"
                clickable
                href={unlinkPrs[ref]}
                target="_blank"
                rel="noopener noreferrer"
              />
            )}
          </>
        );
      }
    },
    {
      title: 'Version',
      render: (row) => version(row) ?? '—'
    },
    {
      title: 'Source',
      render: (row) => {
        const url = sourceUrl(row);
        return url
          ? (
              <Link to={url} title={url}>
                {elideCollectionUrl(url, MAX_SOURCE_URL_CHARS)}
              </Link>
            )
          : '—';
      }
    },
    {
      title: 'Actions',
      width: '1%',
      sorting: false,
      render: (row) => (
        <CollectionActions
          collection={row}
          onUnlink={() => setUnlinkTarget(row)}
        />
      )
    }
  ];

  let body: JSX.Element;
  if (loading) {
    body = <Progress />;
  } else if (error) {
    body = (
      <WarningPanel
        title="Could not load Bruno collections"
        message={error.message}
      />
    );
  } else if (!entities || entities.length === 0) {
    body = (
      <Typography
        variant="body2"
        color="textSecondary"
        className={classes.empty}
      >
        No Bruno collection documents this API yet. Use{' '}
        <strong>Link collection</strong> above to attach one — that adds this
        API to the collection&apos;s <code>partOf</code>, either by a pull
        request against its <code>catalog-info.yaml</code> or as a link in this
        Backstage instance, and the catalog turns either one into the relation
        shown here.
      </Typography>
    );
  } else {
    body = (
      <Table
        options={{ search: false, paging: false, toolbar: false, padding: 'dense' }}
        columns={columns}
        data={entities}
      />
    );
  }

  return (
    <BrunoInfoCard
      title="Bruno Collections"
      noPadding
      action={(
        <Box mr={1} mt={1}>
          <Button size="small" onClick={() => setLinkOpen(true)}>
            Link collection
          </Button>
        </Box>
      )}
    >
      {body}

      {(linkPrs.length > 0 || pendingLinks.length > 0) && (
        <Box className={classes.prStrip}>
          {pendingLinks.map((ref) => (
            <Chip
              key={ref}
              size="small"
              variant="outlined"
              label={`Linking in this instance: ${ref}`}
            />
          ))}
          {linkPrs.map((pr) => (
            <Chip
              key={pr.link}
              size="small"
              label={`Link PR open: ${pr.label}`}
              component="a"
              clickable
              href={pr.link}
              target="_blank"
              rel="noopener noreferrer"
            />
          ))}
        </Box>
      )}

      {unlinkTarget && (
        <UnlinkDialog
          open
          // The row's collection owns the link being removed; this API is the
          // reference taken out of its `partOf`.
          collection={unlinkTarget}
          apiRef={apiRef}
          onClose={() => setUnlinkTarget(undefined)}
          onPrOpened={(link) =>
            setUnlinkPrs((prs) => ({
              ...prs,
              [stringifyEntityRef(unlinkTarget)]: link
            }))}
          onRuntimeUnlinked={(refreshRequested) => {
            setRuntimeUnlinked((refs) => [
              ...refs,
              stringifyEntityRef(unlinkTarget)
            ]);
            refreshRelations(refreshRequested);
          }}
        />
      )}

      <LinkCollectionDialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        apiEntity={entity}
        linkedRefs={(entities ?? []).map((e) => stringifyEntityRef(e))}
        onPrOpened={(collectionRef, link) =>
          setLinkPrs((prs) => [...prs, { label: collectionRef, link }])}
        onRuntimeLinked={(collectionRef, refreshRequested) => {
          setRuntimeLinked((refs) => [...refs, collectionRef]);
          // The dialog stays open on its confirmation screen, so the refresh
          // has to be scheduled from here rather than on close: by the time the
          // user dismisses it, the row is usually already in the table.
          refreshRelations(refreshRequested);
        }}
      />
    </BrunoInfoCard>
  );
}
