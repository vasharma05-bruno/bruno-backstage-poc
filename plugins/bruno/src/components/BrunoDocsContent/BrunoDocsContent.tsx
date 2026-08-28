import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { makeStyles } from '@material-ui/core/styles';
import Button from '@material-ui/core/Button';
import Typography from '@material-ui/core/Typography';
import LaunchIcon from '@material-ui/icons/Launch';
import { ContentHeader, Progress } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { brunoApiRef } from '../../api/BrunoApi';
import { getCollectionId } from '../../lib/annotations';
import { subscribeConnectionChange } from '../../lib/connectionEvents';
import { useDocsSession } from '../../lib/docsSession';
import { useBrandStyles } from '../../theme/brandStyles';

/**
 * Gap left below the iframe so its bottom edge stops short of the viewport
 * floor rather than pushing the entity page's own bottom padding into a
 * scrollbar.
 */
const BOTTOM_GUTTER = 24;

/** Shortest the docs frame is ever drawn, however cramped the viewport. */
const MIN_FRAME_HEIGHT = 320;

type State
  = | { status: 'loading' }
    | { status: 'unlinked' }
    | { status: 'ready'; collectionId: string; name: string }
    | { status: 'error'; errorMsg: string };

const useStyles = makeStyles({
  // The entity tab panel isn't viewport-anchored (its height collapses to
  // content), so a `height: 100%` iframe would fall back to the intrinsic
  // ~150px. The height is measured at runtime instead (see below) and applied
  // inline; this rule covers the rest.
  frame: {
    display: 'block',
    width: '100%',
    border: 0
  }
});

/**
 * Catalog entity tab rendering the linked Bruno collection's OpenCollection API
 * docs, headed `Bruno:<collection-name>`.
 *
 * The heading is a `ContentHeader`, which renders a `<Helmet title>` as well as
 * the visible title. Mounting deeper than the entity layout's own title Helmet,
 * it wins the document title and slots into that layout's title template — so
 * the browser tab reads `<entity> | Bruno:<collection-name> | <app>`. The
 * collection name therefore shows up both above the docs and in the browser
 * tab, even though the entity tab STRIP carries the static "Bruno" label that
 * `EntityContentBlueprint` requires (its `title` is a plain string resolved at
 * registration time, with no entity in hand).
 *
 * The docs are embedded by iframe `src` rather than rendered inline: that gives
 * the OpenCollection bundle a real origin for its `sessionStorage`/HashRouter,
 * and is the same document the standalone `/bruno/docs/:collectionId` page
 * shows. `useDocsSession` mints the cookie that authenticates that `src` GET.
 *
 * The collection is resolved the same way `BrunoCard` resolves it: from the
 * `bruno.dev/collection-id` annotation when present, otherwise by asking the
 * backend for the entity's connection. That second path is what matters — the
 * annotation is only stamped when the catalog re-processes the entity, minutes
 * after a connect, and gating the docs on it would leave a freshly connected
 * collection looking unlinked. The tab is attached to every API entity for the
 * same reason (see `brunoDocsContent` in extensions.tsx), so it also has to
 * render an honest empty state when nothing is linked.
 */
export function BrunoDocsContent(): JSX.Element {
  const classes = useStyles();
  const brandClasses = useBrandStyles();
  const { entity } = useEntity();
  const brunoApi = useApi(brunoApiRef);

  const entityRef = stringifyEntityRef(entity);
  const annotationCollectionId = getCollectionId(entity);

  const [state, setState] = useState<State>({ status: 'loading' });
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Re-resolve the collection when it is re-pointed from the Overview tab's
  // Bruno card, so the heading doesn't keep naming the old collection.
  useEffect(
    () => subscribeConnectionChange(entityRef, () => setRefreshNonce((n) => n + 1)),
    [entityRef]
  );

  // Resolve which collection to document, and its own name — the entity's name
  // can differ from it, and it is the collection being documented here.
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    const load = async (): Promise<void> => {
      const id = annotationCollectionId
        ?? (await brunoApi.getConnection(entityRef))?.collectionId;
      if (cancelled) {
        return;
      }
      if (!id) {
        setState({ status: 'unlinked' });
        return;
      }
      const detail = await brunoApi.getCollection(id);
      if (!cancelled) {
        setState({ status: 'ready', collectionId: id, name: detail.name });
      }
    };

    load().catch((e) => {
      if (!cancelled) {
        setState({
          status: 'error',
          errorMsg: e instanceof Error ? e.message : String(e)
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [brunoApi, entityRef, annotationCollectionId, refreshNonce]);

  // Only authenticate a docs session once a collection is actually resolved.
  const { src, error } = useDocsSession(
    state.status === 'ready' ? state.collectionId : undefined
  );

  // Fill from the iframe's top edge to the bottom of the viewport. Recomputed
  // on mount, when the iframe appears, and on resize.
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frameHeight, setFrameHeight] = useState<number | undefined>();
  useLayoutEffect(() => {
    const recompute = () => {
      const node = frameRef.current;
      if (!node) {
        return;
      }
      const top = node.getBoundingClientRect().top;
      setFrameHeight(
        Math.max(MIN_FRAME_HEIGHT, window.innerHeight - top - BOTTOM_GUTTER)
      );
    };
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [src]);

  if (state.status === 'loading') {
    return <Progress />;
  }

  if (state.status === 'unlinked') {
    return (
      <Typography variant="body2" color="textSecondary">
        No Bruno collection is linked to this entity. Link one from the Bruno
        Collection card on the Overview tab.
      </Typography>
    );
  }

  if (state.status === 'error') {
    return (
      <Typography variant="body2" color="error">
        {state.errorMsg}
      </Typography>
    );
  }

  const { collectionId } = state;

  // Opens the standalone docs page chrome-less in a real browser tab, matching
  // the same action on `/bruno/docs/:collectionId`.
  const openInNewTab = () => {
    window.open(
      `/bruno/docs/${encodeURIComponent(collectionId)}?view=full`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  let body: JSX.Element;
  if (error) {
    body = (
      <Typography variant="body2" color="error">
        {error}
      </Typography>
    );
  } else if (!src) {
    body = <Progress />;
  } else {
    body = (
      <iframe
        ref={frameRef}
        title="API Documentation"
        className={classes.frame}
        style={{ height: frameHeight }}
        sandbox="allow-scripts allow-same-origin"
        src={src}
      />
    );
  }

  return (
    <>
      <ContentHeader title={`Bruno:${state.name}`}>
        <Button
          size="small"
          className={brandClasses.accentText}
          startIcon={<LaunchIcon />}
          onClick={openInNewTab}
        >
          Open in new tab
        </Button>
      </ContentHeader>
      {body}
    </>
  );
}
