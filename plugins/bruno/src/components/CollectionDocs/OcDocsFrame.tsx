import { useEffect, useState } from 'react';
import { makeStyles, useTheme } from '@material-ui/core/styles';
import {
  Content,
  EmptyState,
  Progress,
  ResponseErrorPanel
} from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { brunoApiRef } from '../../api/BrunoApi';
import { getCollectionId } from '../../lib/annotations';
import { subscribeConnectionChange } from '../../lib/connectionEvents';

const useStyles = makeStyles(() => ({
  frame: {
    width: '100%',
    height: '80vh',
    border: 0
  }
}));

/**
 * Renders a connected collection's API docs by embedding the OpenCollection
 * docs page served by the backend (`GET /collections/:id/docs`) via an iframe
 * `src`. The backend page is a real document on the backend origin, which — as
 * opposed to the previous `srcdoc` approach — gives the OpenCollection bundle a
 * real URL/origin so its `sessionStorage` access and `HashRouter` routing work.
 *
 * The frame is cross-origin to the app (backend :7007 vs app :3000 in dev); the
 * backend relaxes `X-Frame-Options`/CSP `frame-ancestors` on that response so
 * the app may embed it. The theme is passed as a query param and the frame
 * reloads on connection changes via a cache-busting nonce.
 */
export function OcDocsFrame() {
  const classes = useStyles();
  const theme = useTheme();
  const { entity } = useEntity();
  const brunoApi = useApi(brunoApiRef);

  const entityRef = stringifyEntityRef(entity);
  const annotationCollectionId = getCollectionId(entity);
  const themeMode: 'light' | 'dark'
    = theme.palette.type === 'dark' ? 'dark' : 'light';

  const [src, setSrc] = useState<string | undefined>();
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

    const resolveId = annotationCollectionId
      ? Promise.resolve(annotationCollectionId)
      : brunoApi.getConnection(entityRef).then((record) => record?.collectionId);

    resolveId
      .then(async (collectionId) => {
        if (cancelled) return;
        if (!collectionId) {
          setNotConnected(true);
          return;
        }
        const url = await brunoApi.getDocsUrl(collectionId, themeMode);
        if (cancelled) return;
        // The nonce forces the iframe to reload when the connection changes.
        setSrc(`${url}&v=${refreshNonce}`);
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
  }, [brunoApi, entityRef, annotationCollectionId, themeMode, refreshNonce]);

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
  if (!src) {
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

  return (
    <Content>
      {/*
        The docs page is served from the backend origin, so allow-same-origin
        here grants the frame its OWN (backend) origin — needed for the bundle's
        sessionStorage — while keeping it cross-origin to (and isolated from) the
        Backstage app that embeds it.
      */}
      <iframe
        title="API Documentation"
        className={classes.frame}
        sandbox="allow-scripts allow-same-origin"
        src={src}
      />
    </Content>
  );
}
