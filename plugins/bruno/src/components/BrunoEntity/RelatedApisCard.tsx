import { useState } from 'react';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import Chip from '@material-ui/core/Chip';
import IconButton from '@material-ui/core/IconButton';
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
import { descriptorLocation } from '../../lib/brunoEntity';
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
 * here rather than rendered as a dead row.
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
   * Link pull requests, as `[apiRef, url]`. Kept separately from `openPrs`
   * because a linked API is NOT in the table yet — the relation only exists
   * once the pull request is merged and the descriptor re-read — so there is no
   * row to hang a chip on.
   */
  const [linkPrs, setLinkPrs] = useState<{ apiRef: string; link: string }[]>([]);

  const columns: TableColumn<Entity>[] = [
    {
      title: 'Name',
      field: 'metadata.name',
      render: (row) => (
        <>
          <EntityRefLink entityRef={row} defaultKind="api" />
          {openPrs[stringifyEntityRef(row)] && (
            <Chip
              size="small"
              label="Unlink PR open"
              component="a"
              clickable
              href={openPrs[stringifyEntityRef(row)]}
              target="_blank"
              rel="noopener noreferrer"
            />
          )}
        </>
      )
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
  // Why this collection's links cannot be edited from here, when they cannot —
  // the same four cases the link and unlink dialogs explain, in the one place a
  // reader looking at an empty card will actually be.
  const location = descriptorLocation(entity);
  const emptyHint = useDescriptorAdvice({ location, direction: 'link' }) ?? (
    <Typography variant="body2" color="textSecondary" component="span">
      Use <strong>Link API</strong> above to attach one — that adds the API to
      this collection&apos;s <code>spec.partOf</code>, which is what the catalog
      turns into the relation shown here.
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
            Link API
          </Button>
        </Box>
      )}
    >
      {body}

      {linkPrs.length > 0 && (
        <Box className={classes.prStrip}>
          {linkPrs.map((pr) => (
            <Chip
              key={pr.link}
              size="small"
              label={`Link PR open: ${pr.apiRef}`}
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
          onSubmitted={(link) =>
            setOpenPrs((prs) => ({ ...prs, [unlinkTarget]: link }))}
        />
      )}

      <LinkApiDialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        collection={entity}
        linkedRefs={(entities ?? []).map((e) => stringifyEntityRef(e))}
        onSubmitted={(apiRef, link) =>
          setLinkPrs((prs) => [...prs, { apiRef, link }])}
      />
    </BrunoInfoCard>
  );
}
