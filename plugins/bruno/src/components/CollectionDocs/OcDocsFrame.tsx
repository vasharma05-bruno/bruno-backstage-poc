import { useEffect, useMemo, useState } from 'react';
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

const CDN = 'https://staging.cdn.opencollection.com';

const useStyles = makeStyles(() => ({
  frame: {
    width: '100%',
    height: '80vh',
    border: 0
  }
}));

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSrcDoc(
  yaml: string,
  title: string,
  theme: 'light' | 'dark'
): string {
  // Neutralize any `</script` (the HTML tokenizer ends a script element on
  // `</script` followed by whitespace, `/`, or `>`, not just `</script>`).
  // The capture group preserves the original casing of the tag.
  const data = JSON.stringify(yaml).replace(/<(\/script)/gi, '<\\$1');
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>',
    `<title>${escapeHtml(title)} - API Documentation</title>`,
    '<style>body{margin:0;padding:0}#opencollection-container{width:100vw;height:100vh}</style>',
    `<link rel="stylesheet" href="${CDN}/docs.css"/>`,
    `<script src="${CDN}/docs.js"></script>`,
    '</head><body><div id="opencollection-container"></div>',
    '<script>',
    `const collectionData = ${data};`,
    'new window.OpenCollection({',
    'target: document.getElementById(\'opencollection-container\'),',
    'opencollection: collectionData,',
    `theme: '${theme}' });`,
    '</script></body></html>'
  ].join('');
}

export function OcDocsFrame() {
  const classes = useStyles();
  const theme = useTheme();
  const { entity } = useEntity();
  const brunoApi = useApi(brunoApiRef);

  const entityRef = stringifyEntityRef(entity);
  const annotationCollectionId = getCollectionId(entity);
  const themeMode: 'light' | 'dark'
    = theme.palette.type === 'dark' ? 'dark' : 'light';

  const [yaml, setYaml] = useState<string | undefined>();
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
        return brunoApi.getOpenCollectionYaml(collectionId).then((y) => {
          if (cancelled) return;
          setYaml(y);
          setError(undefined);
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

  const srcDoc = useMemo(
    () =>
      yaml
        ? buildSrcDoc(
            yaml,
            entity.metadata.title ?? entity.metadata.name,
            themeMode
          )
        : '',
    [yaml, entity.metadata.title, entity.metadata.name, themeMode]
  );

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
  if (!yaml) {
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
        allow-same-origin is required: the OpenCollection bundle reads
        sessionStorage/localStorage and resolves dynamic imports, which throw
        under an opaque (sandboxed) origin. With srcdoc this gives the frame the
        app's origin, so the third-party bundle + rendered collection content
        can reach the app's session — accepted for the POC; Beta hardening =
        serve the host page from a separate origin (bruno-backend) instead.
      */}
      <iframe
        title="API Documentation"
        className={classes.frame}
        sandbox="allow-scripts allow-same-origin"
        srcDoc={srcDoc}
      />
    </Content>
  );
}
