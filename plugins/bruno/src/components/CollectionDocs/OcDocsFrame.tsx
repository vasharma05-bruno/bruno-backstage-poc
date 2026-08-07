import { useEffect, useState } from 'react';
import {
  Content,
  EmptyState,
  Progress,
  ResponseErrorPanel
} from '@backstage/core-components';
import Button from '@material-ui/core/Button';
import Typography from '@material-ui/core/Typography';
import LaunchIcon from '@material-ui/icons/Launch';
import { useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { brunoApiRef } from '../../api/BrunoApi';
import { getCollectionId } from '../../lib/annotations';
import { subscribeConnectionChange } from '../../lib/connectionEvents';

/**
 * "API Docs" entity tab.
 *
 * Resolves the connected collection id (from the `bruno.dev/collection-id`
 * annotation, falling back to a runtime connection lookup) and offers a launcher
 * that opens the standalone full-screen docs page (`/bruno/docs?c=<id>`) in a new
 * browser tab. The OpenCollection docs render full-viewport on that dedicated
 * page rather than embedded inline here (see components/BrunoDocsPage). Renders
 * loading / not-connected / error states while resolving.
 */
export function OcDocsFrame() {
  const { entity } = useEntity();
  const brunoApi = useApi(brunoApiRef);

  const entityRef = stringifyEntityRef(entity);
  const annotationCollectionId = getCollectionId(entity);

  const [collectionId, setCollectionId] = useState<string | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [loading, setLoading] = useState(true);
  const [notConnected, setNotConnected] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(
    () => subscribeConnectionChange(entityRef, () => setRefreshNonce((n) => n + 1)),
    [entityRef]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotConnected(false);
    setError(undefined);
    setCollectionId(undefined);

    const resolveId = annotationCollectionId
      ? Promise.resolve(annotationCollectionId)
      : brunoApi.getConnection(entityRef).then((record) => record?.collectionId);

    resolveId
      .then((id) => {
        if (cancelled) return;
        if (!id) {
          setNotConnected(true);
          return;
        }
        setCollectionId(id);
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
  if (!collectionId) {
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

  const openDocs = () => {
    // Open the standalone full-screen docs page in a new tab. Relative URL keeps
    // it on the app origin (the page then embeds the backend docs iframe).
    window.open(
      `/bruno/docs?c=${encodeURIComponent(collectionId)}`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  return (
    <Content>
      <Typography variant="body1" gutterBottom>
        The Bruno API documentation opens in a dedicated full-screen view.
      </Typography>
      <Button
        variant="contained"
        color="primary"
        startIcon={<LaunchIcon />}
        onClick={openDocs}
      >
        Open API docs
      </Button>
    </Content>
  );
}
