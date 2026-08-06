import { useEffect, useMemo, useState } from 'react';
import { Progress, WarningPanel } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import TextField from '@material-ui/core/TextField';
import Typography from '@material-ui/core/Typography';
import { brunoApiRef } from '../../api/BrunoApi';
import type { Dashboard } from '../../api/types';
import { StatTiles } from './StatTiles';
import { FailuresStrip } from './FailuresStrip';
import { CollectionGrid } from './CollectionGrid';
import { AddCollectionModal } from './AddCollectionModal';

type State
  = | { status: 'loading' }
    | { status: 'ready'; dashboard: Dashboard }
    | { status: 'error'; error: Error };

/**
 * Collections tab: loads the dashboard aggregate once, then renders stat tiles,
 * a failures strip (when any), a client-side search box, and a 2-column card
 * grid. Search filters over name / specType / activeEnv (case-insensitive).
 */
export function CollectionsTab(props: {
  onRequestLink?: (collectionId: string) => void;
}): JSX.Element {
  const { onRequestLink } = props;
  const brunoApi = useApi(brunoApiRef);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    brunoApi
      .getDashboard()
      .then((dashboard) => {
        if (!cancelled) {
          setState({ status: 'ready', dashboard });
        }
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
  }, [brunoApi, refreshKey]);

  const dashboard = state.status === 'ready' ? state.dashboard : undefined;

  const filtered = useMemo(() => {
    if (!dashboard) {
      return [];
    }
    const q = query.trim().toLowerCase();
    if (!q) {
      return dashboard.collections;
    }
    return dashboard.collections.filter((c) =>
      [c.name, c.specType, c.activeEnv]
        .filter((v): v is string => Boolean(v))
        .some((v) => v.toLowerCase().includes(q))
    );
  }, [dashboard, query]);

  if (state.status === 'loading') {
    return <Progress />;
  }

  if (state.status === 'error') {
    return (
      <WarningPanel severity="error" title="Failed to load Bruno dashboard">
        {state.error.message}
      </WarningPanel>
    );
  }

  return (
    <Box>
      <Box mb={2}>
        <StatTiles stats={state.dashboard.stats} />
      </Box>

      {state.dashboard.failures.length > 0 && (
        <Box mb={2}>
          <FailuresStrip failures={state.dashboard.failures} />
        </Box>
      )}

      <Box
        mb={2}
        display="flex"
        alignItems="flex-start"
        justifyContent="space-between"
        style={{ gap: 16 }}
      >
        <TextField
          fullWidth
          label="Search collections"
          placeholder="Search by name, spec type, or environment"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button
          variant="contained"
          color="primary"
          onClick={() => setAddOpen(true)}
        >
          Add collection
        </Button>
      </Box>

      {filtered.length === 0 ? (
        <Typography variant="body2" color="textSecondary">
          No collections match your search.
        </Typography>
      ) : (
        <CollectionGrid collections={filtered} onRequestLink={onRequestLink} />
      )}

      <AddCollectionModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onImported={() => {
          setAddOpen(false);
          setRefreshKey((k) => k + 1);
        }}
      />
    </Box>
  );
}
