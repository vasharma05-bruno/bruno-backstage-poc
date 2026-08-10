import { useEffect, useState } from 'react';
import { makeStyles, useTheme } from '@material-ui/core/styles';
import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import { Progress } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { useRouteRefParams } from '@backstage/frontend-plugin-api';
import { brunoApiRef } from '../../api/BrunoApi';
import { brunoDocsPageRouteRef } from '../../extensions';

const useStyles = makeStyles((theme) => ({
  frame: {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    border: 0,
    // Sit above the app chrome (sidebar/header) so only the docs are visible.
    zIndex: theme.zIndex.modal + 1
  },
  message: {
    padding: theme.spacing(4)
  }
}));

/**
 * Standalone, chrome-less full-viewport page that renders a Bruno collection's
 * OpenCollection API docs. Opened in a new tab (e.g. from a "Run in Bruno"
 * action) as `/bruno/docs/<collectionId>`; the fixed, full-viewport iframe
 * overlays the app sidebar so only the docs show.
 *
 * The iframe embeds the backend-served docs page (`GET /collections/:id/docs`)
 * by `src` — the same document the entity "API Docs" tab uses — so the
 * OpenCollection bundle gets a real origin for its `sessionStorage`/HashRouter.
 */
export function BrunoDocsPage(): JSX.Element {
  const classes = useStyles();
  const theme = useTheme();
  const brunoApi = useApi(brunoApiRef);
  // Read the collection id from the `:collectionId` path parameter bound to
  // the page's route ref (see extensions.tsx).
  const { collectionId } = useRouteRefParams(brunoDocsPageRouteRef);
  const themeMode: 'light' | 'dark'
    = theme.palette.type === 'dark' ? 'dark' : 'light';

  const [src, setSrc] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setSrc(undefined);
    setError(undefined);
    if (!collectionId) {
      setError('Missing collection id in the URL path.');
      return undefined;
    }
    brunoApi
      .getDocsUrl(collectionId, themeMode)
      .then((url) => {
        if (!cancelled) {
          setSrc(url);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [brunoApi, collectionId, themeMode]);

  if (error) {
    return (
      <Box className={classes.message}>
        <Typography variant="body1" color="error">
          {error}
        </Typography>
      </Box>
    );
  }
  if (!src) {
    return (
      <Box className={classes.message}>
        <Progress />
      </Box>
    );
  }

  return (
    <iframe
      title="API Documentation"
      className={classes.frame}
      sandbox="allow-scripts allow-same-origin"
      src={src}
    />
  );
}
