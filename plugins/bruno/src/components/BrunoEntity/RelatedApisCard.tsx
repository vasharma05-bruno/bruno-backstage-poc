import { useState } from 'react';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import Chip from '@material-ui/core/Chip';
import IconButton from '@material-ui/core/IconButton';
import Tooltip from '@material-ui/core/Tooltip';
import Menu from '@material-ui/core/Menu';
import MenuItem from '@material-ui/core/MenuItem';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import MoreVertIcon from '@material-ui/icons/MoreVert';
import { Progress, Table, WarningPanel } from '@backstage/core-components';
import type { TableColumn } from '@backstage/core-components';
import {
  RELATION_OWNED_BY,
  RELATION_PART_OF,
  stringifyEntityRef
} from '@backstage/catalog-model';
import type { Entity } from '@backstage/catalog-model';
import {
  EntityRefLink,
  EntityRefLinks,
  getEntityRelations,
  useEntity,
  useRelatedEntities
} from '@backstage/plugin-catalog-react';
import { BrunoInfoCard } from '../BrunoInfoCard';
import { useDescriptorAdvice } from '../PartOfPr';
import { descriptorLocation, linkSource } from '../../lib/brunoEntity';
import { useRuntimeWritesEnabled } from '../../lib/runtimeWrites';
import { useEntityRelationRefresh } from '../../lib/entityRefresh';
import { LinkApiDialog } from './LinkApiDialog';
import { UnlinkDialog } from './UnlinkDialog';

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
 * The per-row action menu: Unlink.
 *
 * Its own component because each row needs its own menu anchor, and a hook
 * cannot be called from a `render` callback. Mirrors `CollectionActions` on the
 * API side of the same relation, so the two ends of a link behave alike.
 */
function ApiActions(props: {
  api: Entity;
  onUnlink: () => void;
}): JSX.Element {
  const { api, onUnlink } = props;
  const classes = useStyles();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const close = (): void => setAnchor(null);

  return (
    <>
      <IconButton
        size="small"
        aria-label={`Actions for ${api.metadata.name}`}
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={close}>
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
    </>
  );
}

/**
 * Overview card listing the API entities this collection documents.
 *
 * The relation is read, not the spec: `BrunoKindProcessor` emits both directions
 * of the `partOf`/`hasPart` pair, and reading the RELATION means an entity that
 * `spec.partOf` names but that does not exist in the catalog is simply absent
 * here rather than rendered as a dead row — and it means the list covers links
 * made in this instance as well as the ones the descriptor declares, since the
 * processor emits the same relation for both. The per-row chip is where that
 * difference shows, because it decides what Unlink has to do.
 *
 * Built on core-components `Table` rather than `EntityRelationCard`: the latter
 * has no per-row action slot, and its cells must be `@backstage/ui` components,
 * which would put a second design system inside a Material-UI v4 card.
 */
export function RelatedApisCard(): JSX.Element {
  const classes = useStyles();
  const { entity } = useEntity();
  const { entities, loading, error } = useRelatedEntities(entity, {
    type: RELATION_PART_OF,
    kind: 'API'
  });

  // Re-reads THIS collection after a runtime link change, which is what makes
  // the relation above appear or go: `useRelatedEntities` derives its list from
  // the relations on the entity object, so nothing moves until it is fetched
  // again.
  const refreshRelations = useEntityRelationRefresh();

  const [linkOpen, setLinkOpen] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<string | undefined>();
  /**
   * Open unlink pull requests, keyed by API entity ref.
   *
   * Session state on purpose. Persisting it would mean a side store of link
   * state outside source control, which is exactly what the relation model
   * exists to avoid — so after a reload the chip is gone and the pull request
   * lives where it belongs, in the SCM host.
   */
  const [openPrs, setOpenPrs] = useState<Record<string, string>>({});
  /**
   * Link pull requests, as the APIs they add and the pull request URL. Kept
   * separately from `openPrs` because a linked API is NOT in the table yet —
   * the relation only exists once the pull request is merged and the descriptor
   * re-read — so there is no row to hang a chip on. The names travel with the
   * chip for the same reason: nothing else on screen says what was linked.
   */
  const [linkPrs, setLinkPrs] = useState<{ names: string; link: string }[]>([]);
  /**
   * APIs linked at RUNTIME in this session, and ones whose runtime link was
   * just removed.
   *
   * Also session state, and for a different reason from the pull requests:
   * these changes have already happened and are seconds from being visible, so
   * the chips are progress indicators rather than records. The linked ones are
   * dropped as soon as they turn up in `entities`, which is the event they
   * exist to cover.
   */
  const [runtimeLinked, setRuntimeLinked] = useState<string[]>([]);
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
        const source = linkSource(entity, ref);
        return (
          <>
            <EntityRefLink entityRef={row} defaultKind="api" />
            {(source === 'runtime' || source === 'both') && (
              <Tooltip
                title={
                  source === 'both'
                    ? 'Linked both in this Backstage instance and in this '
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
              <Chip size="small" className={classes.chip} label="Unlinking…" />
            )}
            {openPrs[ref] && (
              <Chip
                size="small"
                className={classes.chip}
                label="Unlink PR open"
                component="a"
                clickable
                href={openPrs[ref]}
                target="_blank"
                rel="noopener noreferrer"
              />
            )}
          </>
        );
      }
    },
    {
      title: 'Type',
      field: 'spec.type',
      render: (row) => String(row.spec?.type ?? '—')
    },
    {
      title: 'Owner',
      render: (row) => (
        <EntityRefLinks
          entityRefs={getEntityRelations(row, RELATION_OWNED_BY)}
          defaultKind="group"
        />
      )
    },
    {
      title: 'Actions',
      width: '1%',
      sorting: false,
      render: (row) => (
        <ApiActions
          api={row}
          onUnlink={() => setUnlinkTarget(stringifyEntityRef(row))}
        />
      )
    }
  ];

  let body: JSX.Element;
  // Why this collection's `spec.partOf` cannot be edited from here, when it
  // cannot — the same five cases the link and unlink dialogs explain, in the one
  // place a reader looking at an empty card will actually be. It is no longer
  // the end of the road, so it is followed by the action that still works.
  const location = descriptorLocation(entity);
  const advice = useDescriptorAdvice({ location, direction: 'link' });
  // The follow-up sentence below is the whole reason this card reads the flag:
  // with instance-local writes off, "Link APIs can still record it here"
  // becomes an offer the dialog will not honour, and the advice above it is
  // once again the end of the road rather than a detour sign.
  const runtimeAvailable = useRuntimeWritesEnabled();
  const emptyHint = advice
    ? (
        <>
          {advice}
          {runtimeAvailable && (
            <Typography
              variant="body2"
              color="textSecondary"
              component="span"
            >
              <strong>Link APIs</strong> above can still record the link in this
              Backstage instance instead, which touches no file.
            </Typography>
          )}
        </>
      )
    : (
        <Typography variant="body2" color="textSecondary" component="span">
          Use <strong>Link APIs</strong> above to attach one or more — that adds
          them to this collection&apos;s <code>partOf</code>,{' '}
          {runtimeAvailable
            ? 'by a pull request against its catalog-info.yaml or as a link in '
            + 'this Backstage instance, and the catalog turns either one into '
            + 'the relations shown here.'
            : 'by a pull request against its catalog-info.yaml, and the catalog '
              + 'turns that into the relations shown here.'}
        </Typography>
      );

  if (loading) {
    body = <Progress />;
  } else if (error) {
    body = (
      <WarningPanel title="Could not load related APIs" message={error.message} />
    );
  } else if (!entities || entities.length === 0) {
    body = (
      <Box className={classes.empty}>
        <Typography variant="body2" color="textSecondary" paragraph>
          This collection is not linked to any API entity.
        </Typography>
        {emptyHint}
      </Box>
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
      title="Related APIs"
      noPadding
      action={(
        <Box mr={1} mt={1}>
          <Button size="small" onClick={() => setLinkOpen(true)}>
            Link APIs
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
              label={`Link PR open: ${pr.names}`}
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
          collection={entity}
          apiRef={unlinkTarget}
          onClose={() => setUnlinkTarget(undefined)}
          onPrOpened={(link) =>
            setOpenPrs((prs) => ({ ...prs, [unlinkTarget]: link }))}
          onRuntimeUnlinked={(refreshRequested) => {
            setRuntimeUnlinked((refs) => [...refs, unlinkTarget]);
            refreshRelations(refreshRequested);
          }}
        />
      )}

      <LinkApiDialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        collection={entity}
        linkedRefs={(entities ?? []).map((e) => stringifyEntityRef(e))}
        onPrOpened={(apis, link) =>
          setLinkPrs((prs) => [
            ...prs,
            {
              names: apis
                .map((api) => api.metadata.title ?? api.metadata.name)
                .join(', '),
              link
            }
          ])}
        onRuntimeLinked={(apis, refreshRequested) => {
          setRuntimeLinked((refs) => [
            ...refs,
            ...apis.map((api) => stringifyEntityRef(api))
          ]);
          // The dialog stays open on its confirmation screen, so the refresh is
          // scheduled from here rather than on close: by the time the user
          // dismisses it, the rows are usually already in the table.
          refreshRelations(refreshRequested);
        }}
      />
    </BrunoInfoCard>
  );
}
