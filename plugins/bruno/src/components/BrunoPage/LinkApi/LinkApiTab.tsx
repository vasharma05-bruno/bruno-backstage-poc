import { useEffect, useState } from 'react';
import { EmptyState, Progress, WarningPanel } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import Box from '@material-ui/core/Box';
import { BRUNO_COLLECTION_PATH_ANNOTATION } from '../../../lib/annotations';
import { ApiList, toUnlinkedApi } from './ApiList';
import type { UnlinkedApi } from './ApiList';
import { LinkPanel } from './LinkPanel';

type State
  = | { status: 'loading' }
    | { status: 'ready'; apis: UnlinkedApi[] }
    | { status: 'error'; error: Error };

/**
 * Link API tab: left column lists catalog `kind:API` entities that lack the
 * Bruno collection-path annotation (client-side drop — the catalog has no
 * server-side annotation-absent filter); the right column links the selected
 * entity to a Bruno collection by repository URL.
 */
export function LinkApiTab(props: {
  preselectImportedCollectionId?: string;
}): JSX.Element {
  const { preselectImportedCollectionId } = props;
  const catalogApi = useApi(catalogApiRef);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [selectedRef, setSelectedRef] = useState<string | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    catalogApi
      .getEntities({ filter: { kind: 'API' } })
      .then((response) => {
        if (cancelled) {
          return;
        }
        const apis = response.items
          .filter(
            (e) =>
              !e.metadata.annotations?.[BRUNO_COLLECTION_PATH_ANNOTATION]
          )
          .map(toUnlinkedApi);
        setState({ status: 'ready', apis });
      })
      .catch((e) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: e instanceof Error ? e : new Error(String(e))
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalogApi, refreshKey]);

  if (state.status === 'loading') {
    return <Progress />;
  }

  if (state.status === 'error') {
    return (
      <WarningPanel severity="error" title="Failed to load API entities">
        {state.error.message}
      </WarningPanel>
    );
  }

  const { apis } = state;
  const selected = apis.find((a) => a.entityRef === selectedRef);

  const onLinked = () => {
    setSelectedRef(undefined);
    setRefreshKey((k) => k + 1);
  };

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={6}>
        <Typography variant="subtitle1" gutterBottom>
          APIs without collections ({apis.length})
        </Typography>
        {apis.length === 0 ? (
          <EmptyState
            missing="content"
            title="No unlinked APIs"
            description="Every API entity in the catalog already has a Bruno collection linked."
          />
        ) : (
          <Box>
            <ApiList
              apis={apis}
              selectedRef={selectedRef}
              onSelect={setSelectedRef}
            />
          </Box>
        )}
      </Grid>
      <Grid item xs={12} md={6}>
        <LinkPanel
          selectedRef={selectedRef}
          selectedName={selected?.name}
          onLinked={onLinked}
          preselectImportedCollectionId={preselectImportedCollectionId}
        />
      </Grid>
    </Grid>
  );
}
