import { useState } from 'react';
import { InfoCard, LinkButton } from '@backstage/core-components';
import { parseEntityRef } from '@backstage/catalog-model';
import { useApi } from '@backstage/core-plugin-api';
import Avatar from '@material-ui/core/Avatar';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import Chip from '@material-ui/core/Chip';
import Tooltip from '@material-ui/core/Tooltip';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import { brunoApiRef } from '../../api/BrunoApi';
import { emitConnectionChange } from '../../lib/connectionEvents';
import type { DashboardCollection } from '../../api/types';

const useStyles = makeStyles((theme) => ({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(1)
  },
  avatar: {
    backgroundColor: theme.palette.primary.main,
    width: theme.spacing(4),
    height: theme.spacing(4)
  },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(0.5),
    marginBottom: theme.spacing(1)
  },
  linkedChip: {
    backgroundColor: theme.palette.success.main,
    color: theme.palette.success.contrastText
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(2),
    marginBottom: theme.spacing(1)
  },
  actions: {
    marginTop: theme.spacing(1),
    display: 'flex',
    gap: theme.spacing(1)
  }
}));

/** Deep-link to the catalog entity's Bruno docs tab, or a disabled action. */
function OpenAction(props: { entityRef?: string }): JSX.Element {
  const { entityRef } = props;

  // Resolve a catalog docs-tab link. Guard `parseEntityRef` — a malformed
  // stored entityRef (the connect route doesn't validate its format) would
  // otherwise throw during render and crash the card.
  let target: string | undefined;
  if (entityRef) {
    try {
      const { kind, namespace, name } = parseEntityRef(entityRef);
      target = `/catalog/${namespace.toLowerCase()}/${kind.toLowerCase()}/${encodeURIComponent(
        name
      )}/bruno-docs`;
    } catch {
      target = undefined;
    }
  }

  if (!target) {
    return (
      <Tooltip title="Not linked to a catalog entity">
        <span>
          <Button variant="outlined" size="small" disabled>
            OPEN
          </Button>
        </span>
      </Tooltip>
    );
  }

  return (
    <LinkButton to={target} variant="outlined" size="small">
      OPEN
    </LinkButton>
  );
}

/** Single dashboard collection card. Handles undefined activeEnv/specType. */
export function CollectionCard(props: {
  collection: DashboardCollection;
  onRequestLink?: (collectionId: string) => void;
  onChanged?: () => void;
}): JSX.Element {
  const classes = useStyles();
  const { collection, onRequestLink, onChanged } = props;
  const brunoApi = useApi(brunoApiRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Imported-but-unlinked stub: no entityRef, so no OPEN target — render a
  // "Link" action (in-page deep-link) instead. See D4/D9.
  const isImportedStub = Boolean(collection.imported) && !collection.linked;

  const onUnlink = async () => {
    if (!collection.entityRef) {
      return;
    }
    if (!window.confirm('Unlink this collection from its entity?')) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await brunoApi.disconnect(collection.entityRef);
      emitConnectionChange(collection.entityRef);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!window.confirm('Delete this imported collection?')) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await brunoApi.deleteImportedCollection(collection.id);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <InfoCard>
      <Box className={classes.header}>
        <Avatar className={classes.avatar}>B</Avatar>
        <Typography variant="subtitle1">{collection.name}</Typography>
      </Box>

      <Box className={classes.chips}>
        {collection.linked && (
          <Chip
            className={classes.linkedChip}
            label="linked"
            size="small"
          />
        )}
        {isImportedStub && <Chip label="imported" size="small" />}
        {collection.specType && (
          <Chip label={collection.specType} size="small" />
        )}
      </Box>

      <Box className={classes.meta}>
        <Typography variant="body2" color="textSecondary">
          {collection.requestCount} requests
        </Typography>
        <Typography variant="body2" color="textSecondary">
          {collection.envCount} envs
        </Typography>
        {collection.activeEnv && (
          <Typography variant="body2" color="textSecondary">
            {collection.activeEnv}
          </Typography>
        )}
      </Box>

      <Box className={classes.actions}>
        {isImportedStub ? (
          <>
            <Button
              variant="contained"
              size="small"
              onClick={() => onRequestLink?.(collection.id)}
            >
              Link
            </Button>
            <Button
              variant="outlined"
              size="small"
              onClick={onDelete}
              disabled={busy}
            >
              Delete
            </Button>
          </>
        ) : (
          <>
            <OpenAction entityRef={collection.entityRef} />
            {collection.linked && collection.entityRef && (
              <Button
                variant="outlined"
                size="small"
                onClick={onUnlink}
                disabled={busy}
              >
                Unlink
              </Button>
            )}
          </>
        )}
      </Box>

      {error && (
        <Typography variant="body2" color="error">
          {error}
        </Typography>
      )}
    </InfoCard>
  );
}
