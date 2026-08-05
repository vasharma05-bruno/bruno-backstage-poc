import { useEffect, useState } from 'react';
import { InfoCard, Link, Progress } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import Box from '@material-ui/core/Box';
import { brunoApiRef } from '../../api/BrunoApi';
import type { CollectionDetail } from '../../api/types';
import { getCollectionId, getSourceUrl } from '../../lib/annotations';
import { OpenInBruno } from '../OpenInBruno';

/**
 * Entity card for a `bruno-collection` API entity.
 *
 * Reads `bruno.dev/collection-id` from the entity annotations, fetches the
 * collection detail from the backend for the name / request count, shows the
 * `bruno.dev/source-url` link, and renders the "Open in Bruno" action.
 */
export function BrunoCard() {
  const { entity } = useEntity();
  const brunoApi = useApi(brunoApiRef);

  const collectionId = getCollectionId(entity);
  const sourceUrl = getSourceUrl(entity);

  const [detail, setDetail] = useState<CollectionDetail | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(Boolean(collectionId));

  useEffect(() => {
    let cancelled = false;
    if (!collectionId) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    brunoApi
      .getCollection(collectionId)
      .then((d) => {
        if (!cancelled) {
          setDetail(d);
          setError(undefined);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [brunoApi, collectionId]);

  const name = detail?.name ?? entity.metadata.title ?? entity.metadata.name;

  return (
    <InfoCard title="Bruno Collection">
      {!collectionId && (
        <Typography variant="body2" color="error">
          Missing <code>bruno.dev/collection-id</code> annotation on this
          entity.
        </Typography>
      )}
      {loading && <Progress />}
      {error && (
        <Typography variant="body2" color="error">
          Failed to load collection: {error}
        </Typography>
      )}
      {!loading && collectionId && (
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Typography variant="subtitle1">My name is{name}</Typography>
          </Grid>
          <Grid item xs={6}>
            <Typography variant="caption" color="textSecondary">
              Requests
            </Typography>
            <Typography variant="h6">{detail?.requestCount ?? '—'}</Typography>
          </Grid>
          <Grid item xs={6}>
            <Typography variant="caption" color="textSecondary">
              Source
            </Typography>
            <Typography variant="body2">
              {sourceUrl ? (
                <Link to={sourceUrl}>{shorten(sourceUrl)}</Link>
              ) : (
                '—'
              )}
            </Typography>
          </Grid>
          <Grid item xs={12}>
            <Box mt={1}>
              <OpenInBruno sourceUrl={sourceUrl} />
            </Box>
          </Grid>
        </Grid>
      )}
    </InfoCard>
  );
}

function shorten(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return url;
  }
}
