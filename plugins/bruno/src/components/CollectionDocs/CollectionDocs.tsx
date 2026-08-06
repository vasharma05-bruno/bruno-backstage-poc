import { useEffect, useState } from 'react';
import Grid from '@material-ui/core/Grid';
import Paper from '@material-ui/core/Paper';
import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import {
  Content,
  EmptyState,
  InfoCard,
  Progress,
  ResponseErrorPanel
} from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { brunoApiRef } from '../../api/BrunoApi';
import type { CollectionDetail, RequestItem } from '../../api/types';
import { getCollectionId } from '../../lib/annotations';
import { subscribeConnectionChange } from '../../lib/connectionEvents';
import { CollectionTree } from './CollectionTree';
import { RequestDetail } from './RequestDetail';
import { firstRequestId, flattenRequests } from './tree';

const useStyles = makeStyles((theme) => ({
  treePane: {
    padding: theme.spacing(1),
    maxHeight: '70vh',
    overflowY: 'auto'
  },
  detailPane: {
    padding: theme.spacing(2),
    minHeight: '70vh'
  }
}));

/**
 * Native (from-scratch, per D2) Collection Docs viewer. Fetches the
 * NormalizedCollection via `brunoApi.getCollection(id)` and renders a two-pane
 * layout: request tree on the left, request detail (with tabs + "Try it out")
 * on the right.
 */
export function CollectionDocs() {
  const classes = useStyles();
  const { entity } = useEntity();
  const brunoApi = useApi(brunoApiRef);

  const entityRef = stringifyEntityRef(entity);
  const annotationCollectionId = getCollectionId(entity);

  const [detail, setDetail] = useState<CollectionDetail | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [loading, setLoading] = useState(true);
  const [notConnected, setNotConnected] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(
    () => subscribeConnectionChange(entityRef, () => setRefreshNonce((n) => n + 1)),
    [entityRef]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotConnected(false);

    // Resolve the collection id: annotation (provider-materialized) first,
    // else a stored runtime connection (`getConnection` returns undefined on
    // 404 → not connected), then fetch the collection for the viewer.
    const resolveId = annotationCollectionId
      ? Promise.resolve(annotationCollectionId)
      : brunoApi.getConnection(entityRef).then((record) => record?.collectionId);

    resolveId
      .then((collectionId) => {
        if (cancelled) return undefined;
        if (!collectionId) {
          setNotConnected(true);
          return undefined;
        }
        return brunoApi.getCollection(collectionId).then((d) => {
          if (cancelled) return;
          setDetail(d);
          setError(undefined);
          setSelectedId(firstRequestId(d.collection.items));
        });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [brunoApi, entityRef, annotationCollectionId, refreshNonce]);

  if (loading) {
    return (
      <Content>
        <Progress />
      </Content>
    );
  }
  if (notConnected) {
    return (
      <Content>
        <EmptyState
          missing="content"
          title="No Bruno collection connected"
          description="Use the Bruno card on the Overview tab to connect a collection."
        />
      </Content>
    );
  }
  if (error) {
    return (
      <Content>
        <ResponseErrorPanel error={error} />
      </Content>
    );
  }
  if (!detail) {
    return (
      <Content>
        <EmptyState
          missing="data"
          title="No collection data"
          description="The backend returned no collection."
        />
      </Content>
    );
  }

  const selected: RequestItem | undefined = selectedId
    ? flattenRequests(detail.collection.items).find((r) => r.id === selectedId)
      ?.item
    : undefined;

  return (
    <Content>
      <Box mb={2}>
        <Typography variant="h5">{detail.collection.name}</Typography>
        {detail.collection.version && (
          <Typography variant="caption" color="textSecondary">
            v{detail.collection.version}
          </Typography>
        )}
      </Box>
      <Grid container spacing={2}>
        <Grid item xs={12} md={4} lg={3}>
          <Paper className={classes.treePane} variant="outlined">
            <CollectionTree
              items={detail.collection.items}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </Paper>
        </Grid>
        <Grid item xs={12} md={8} lg={9}>
          <Paper className={classes.detailPane} variant="outlined">
            {selected ? (
              <RequestDetail
                item={selected}
                environments={detail.collection.environments}
              />
            ) : (
              <InfoCard title="Select a request">
                <Typography variant="body2" color="textSecondary">
                  Choose a request from the tree to see its details.
                </Typography>
              </InfoCard>
            )}
          </Paper>
        </Grid>
      </Grid>
    </Content>
  );
}
