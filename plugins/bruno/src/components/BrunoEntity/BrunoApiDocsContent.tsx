import { useLayoutEffect, useRef, useState } from 'react';
import { makeStyles } from '@material-ui/core/styles';
import Typography from '@material-ui/core/Typography';
import { Progress } from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import {
  definition,
  definitionOmittedBytes,
  definitionOmittedReason
} from '../../lib/brunoEntity';
import { useEntityDocsSession } from '../../lib/docsSession';

/**
 * Gap left below the iframe so its bottom edge stops short of the viewport floor
 * rather than pushing the entity page's own bottom padding into a scrollbar.
 */
const BOTTOM_GUTTER = 24;

/** Shortest the docs frame is ever drawn, however cramped the viewport. */
const MIN_FRAME_HEIGHT = 320;

const useStyles = makeStyles({
  // The entity tab panel isn't viewport-anchored (its height collapses to
  // content), so a `height: 100%` iframe would fall back to the intrinsic
  // ~150px. The height is measured at runtime instead and applied inline; this
  // rule covers the rest.
  frame: {
    display: 'block',
    width: '100%',
    border: 0
  }
});

/**
 * The `Bruno API Docs` tab on a `kind: Bruno` entity page.
 *
 * The document is rendered from `spec.definition` — the OpenCollection YAML
 * `BrunoKindProcessor` generates and stores inline on the entity, in the same
 * fashion `kind: API` stores an OpenAPI document — but it is rendered BY THE
 * BACKEND, at `/entities/:namespace/:name/docs`, and framed by `src`. Building
 * the same HTML here and framing it as a `blob:` URL would make the document
 * inherit the app's Content-Security-Policy, which does not allow the
 * OpenCollection renderer's CDN; the backend document has its own origin and
 * its own CSP. See `lib/docsSession.ts`, which also mints the cookie that
 * authenticates the frame's GET.
 *
 * The empty states below still branch on the ENTITY's `spec.definition` rather
 * than on the response: the entity is already in React context, so a collection
 * with no document to show never costs a request, and the reason it has none
 * (too large, generation failed, not processed yet) is right here to explain.
 * The backend serves its own version of these messages as a backstop for anyone
 * opening the docs URL directly.
 *
 * The tab STRIP carries the static "Bruno API Docs" label that
 * `EntityContentBlueprint` requires — its `title` is a plain string resolved at
 * registration time, with no entity in hand, so it cannot name the collection.
 *
 * NOTE: this content previously rendered a `ContentHeader`, whose `<Helmet
 * title>` mounted deeper than the entity layout's own and so won the document
 * title, giving a browser tab reading `<entity> | <collection> | <app>`. That
 * render was dropped in `3417d19`; the tab now falls back to the entity
 * layout's title. Restore the header (or a bare `Helmet`) if that tab title is
 * wanted back.
 */
export function BrunoApiDocsContent(): JSX.Element {
  const classes = useStyles();
  const { entity } = useEntity();

  const definitionYaml = definition(entity);
  // Only open a docs session when there is a document to render — otherwise the
  // empty states below stand in for the frame, and minting a cookie for a frame
  // that is never mounted would be pointless.
  const { namespace = 'default', name } = entity.metadata;
  const { src, error } = useEntityDocsSession(
    definitionYaml ? namespace : undefined,
    definitionYaml ? name : undefined
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

  let body: JSX.Element;
  if (definitionYaml) {
    // `src` is only handed out once the docs cookie exists, so it is undefined
    // for the first frames even when there IS a definition — branching on the
    // definition rather than on `src` is what keeps those frames from flashing
    // the "no docs yet" message.
    if (error) {
      body = (
        <Typography variant="body2" color="error">
          {error}
        </Typography>
      );
    } else {
      body = src
        ? (
            <iframe
              ref={frameRef}
              title="API Documentation"
              className={classes.frame}
              style={{ height: frameHeight }}
              // `allow-downloads` is not decoration: the renderer offers "save
              // this collection" and attachment downloads, both built on
              // `URL.createObjectURL` plus a synthetic `<a download>` click,
              // which a sandboxed frame blocks outright without it. Those
              // controls were visible and silently inert. Independent of
              // `allow-same-origin`, which is what the frame's cookie auth and
              // its blob workers need.
              sandbox="allow-scripts allow-same-origin allow-downloads"
              src={src}
            />
          )
        : <Progress />;
    }
  } else if (definitionOmittedReason(entity) === 'size') {
    // The processor generated the document but left it off the entity because
    // it exceeded `bruno.definition.maxBytes`. Saying "no documentation" here
    // would be wrong and would send the reader looking in the wrong place.
    const bytes = definitionOmittedBytes(entity);
    body = (
      <Typography variant="body2" color="textSecondary">
        This collection&apos;s OpenCollection document
        {bytes ? ` (${bytes} bytes)` : ''} exceeds{' '}
        <code>bruno.definition.maxBytes</code>, so it was not stored on the
        entity and cannot be rendered here. Raise that limit in your Backstage
        configuration, or open the collection in Bruno.
      </Typography>
    );
  } else if (definitionOmittedReason(entity)) {
    body = (
      <Typography variant="body2" color="textSecondary">
        No OpenCollection document is stored on this entity (
        {definitionOmittedReason(entity)}). Check the entity&apos;s processing
        errors for why the collection could not be read.
      </Typography>
    );
  } else {
    body = (
      <Typography variant="body2" color="textSecondary">
        No API documentation has been generated for this collection yet. It is
        written to the entity the first time Backstage reads the collection from
        source control — use Sync in the header and check back in a minute.
      </Typography>
    );
  }

  return (
    <>
      {body}
    </>
  );
}
