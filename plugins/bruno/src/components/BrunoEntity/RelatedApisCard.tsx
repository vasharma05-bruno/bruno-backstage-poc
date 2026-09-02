import { useState } from 'react';
import Button from '@material-ui/core/Button';
import Chip from '@material-ui/core/Chip';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import LinkOffIcon from '@material-ui/icons/LinkOff';
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
import { descriptorLocation } from '../../lib/brunoEntity';
import { UnlinkDialog } from './UnlinkDialog';

const useStyles = makeStyles((theme) => ({
  danger: {
    color: theme.palette.error.main
  },
  empty: {
    padding: theme.spacing(2)
  }
}));

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
        <Button
          size="small"
          className={classes.danger}
          startIcon={<LinkOffIcon />}
          onClick={() => setUnlinkTarget(stringifyEntityRef(row))}
        >
          Unlink
        </Button>
      )
    }
  ];

  let body: JSX.Element;
  // The advice depends on where the entity is DECLARED, not on where the
  // collection lives. A `bruno.collections[]` entry has no descriptor file at
  // all, so telling its operator to edit a catalog-info.yaml sends them looking
  // for a file that does not exist -- see `descriptorLocation`, which carries a
  // distinct reason for each case precisely so the copy can differ.
  const location = descriptorLocation(entity);
  let emptyHint: JSX.Element;
  if (location.kind === 'none' && location.reason === 'provider') {
    emptyHint = (
      <>
        Add the API&apos;s entity reference to <code>partOf</code> on this
        collection&apos;s <code>bruno.collections[]</code> entry in{' '}
        <code>app-config.yaml</code>.
      </>
    );
  } else if (location.kind === 'none' && location.reason === 'discovery') {
    // A discovered collection has no descriptor and no config entry; authoring
    // a descriptor is what takes it over, because discovery defers to one.
    emptyHint = (
      <>
        This collection was discovered by <code>bruno.discovery</code>. Add a{' '}
        <code>catalog-info.yaml</code> declaring <code>kind: Bruno</code> with{' '}
        <code>spec.partOf</code> to its repository, which discovery will then
        leave to that descriptor.
      </>
    );
  } else {
    emptyHint = (
      <>
        Add the API&apos;s entity reference to <code>spec.partOf</code> in the
        collection&apos;s <code>catalog-info.yaml</code>.
      </>
    );
  }

  if (loading) {
    body = <Progress />;
  } else if (error) {
    body = (
      <WarningPanel title="Could not load related APIs" message={error.message} />
    );
  } else if (!entities || entities.length === 0) {
    body = (
      <Typography
        variant="body2"
        color="textSecondary"
        className={classes.empty}
      >
        This collection is not linked to any API entity. {emptyHint}
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
    <BrunoInfoCard title="Related APIs" noPadding>
      {body}
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
    </BrunoInfoCard>
  );
}
