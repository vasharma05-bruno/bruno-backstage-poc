import { Fragment, useEffect, useState } from 'react';
import { InfoCard } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import List from '@material-ui/core/List';
import ListItem from '@material-ui/core/ListItem';
import ListItemText from '@material-ui/core/ListItemText';
import Typography from '@material-ui/core/Typography';
import Box from '@material-ui/core/Box';
import FolderIcon from '@material-ui/icons/Folder';
import { makeStyles } from '@material-ui/core/styles';
import { brunoApiRef } from '../../api/BrunoApi';
import type { CollectionDetail, Item } from '../../api/types';
import { isFolderItem, isRequestItem } from '../../api/types';
import { getCollectionId } from '../../lib/annotations';
import { MethodBadge } from '../MethodBadge';

type State =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'ready'; detail: CollectionDetail }
  | { status: 'error' };

const useStyles = makeStyles((theme) => ({
  requestRow: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1)
  },
  folderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5)
  }
}));

/** Read-only recursive tree of folders and requests (no selection). */
function CompactTree(props: { items: Item[]; prefix?: string }) {
  const classes = useStyles();
  const { items, prefix = '' } = props;

  return (
    <List dense disablePadding>
      {items.map((item, idx) => {
        const id = `${prefix}${idx}`;
        if (isFolderItem(item)) {
          return (
            <Fragment key={id}>
              <ListItem dense>
                <Box className={classes.folderRow}>
                  <FolderIcon fontSize="small" color="action" />
                  <Typography variant="body2">
                    <strong>{item.name}</strong>
                  </Typography>
                </Box>
              </ListItem>
              <Box pl={2}>
                <CompactTree items={item.items} prefix={`${id}.`} />
              </Box>
            </Fragment>
          );
        }
        if (isRequestItem(item)) {
          return (
            <ListItem key={id} dense>
              <Box className={classes.requestRow}>
                <MethodBadge method={item.method} />
                <ListItemText primary={item.name} />
              </Box>
            </ListItem>
          );
        }
        return null;
      })}
    </List>
  );
}

/**
 * Right-column entity card rendering a compact, read-only tree of a Bruno
 * collection. Resolves the collection id from the `bruno.dev/collection-id`
 * annotation, falling back to a runtime connection lookup. Renders nothing
 * (returns `null`) while loading, when the entity has no linked collection, or
 * on error — so unrelated API entities show no empty card slot.
 */
export function CollectionTreeCard(): JSX.Element | null {
  const { entity } = useEntity();
  const brunoApi = useApi(brunoApiRef);

  const entityRef = stringifyEntityRef(entity);
  const annotationCollectionId = getCollectionId(entity);

  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    if (annotationCollectionId) {
      brunoApi
        .getCollection(annotationCollectionId)
        .then((detail) => {
          if (!cancelled) {
            setState({ status: 'ready', detail });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setState({ status: 'error' });
          }
        });
      return () => {
        cancelled = true;
      };
    }

    brunoApi
      .getConnection(entityRef)
      .then((record) => {
        if (cancelled) {
          return undefined;
        }
        if (!record) {
          setState({ status: 'hidden' });
          return undefined;
        }
        return brunoApi.getCollection(record.collectionId).then((detail) => {
          if (!cancelled) {
            setState({ status: 'ready', detail });
          }
        });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: 'error' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [brunoApi, entityRef, annotationCollectionId]);

  if (state.status !== 'ready') {
    return null;
  }

  const items = state.detail.collection.items;
  return (
    <InfoCard title="Collection Tree">
      {items.length === 0 ? (
        <Typography variant="body2" color="textSecondary">
          No requests in this collection.
        </Typography>
      ) : (
        <CompactTree items={items} />
      )}
    </InfoCard>
  );
}
