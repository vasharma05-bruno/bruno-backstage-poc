import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import { CodeSnippet, Link } from '@backstage/core-components';
import { useApiHolder } from '@backstage/core-plugin-api';
import { scmIntegrationsApiRef } from '@backstage/integration-react';
import { InlineNotice } from '../InlineNotice';
import type { DescriptorLocation } from '../../lib/brunoEntity';
import type { PartOfDirection } from '../../lib/unlinkPr';
import { partOfSnippet } from '../../lib/unlinkPr';
import { prSupported } from '../../lib/pr/registry';
import { collectionPathFromUrl } from '../../lib/scmUrl';

const useStyles = makeStyles((theme) => ({
  snippet: {
    marginTop: theme.spacing(1),
    // Short by construction — it is one `spec.partOf` list, not a descriptor —
    // but a collection linked to a dozen APIs should not push the dialog's
    // buttons off screen.
    maxHeight: 200,
    overflow: 'auto'
  }
}));

/** The one word each direction changes in the advice below. */
const WORDING: Record<
  PartOfDirection,
  { Verb: string; verb: string; preposition: string }
> = {
  link: { Verb: 'Add', verb: 'add', preposition: 'to' },
  unlink: { Verb: 'Remove', verb: 'remove', preposition: 'from' }
};

/**
 * Why this collection's `spec.partOf` cannot be edited by pull request, and
 * what to do instead — or `undefined` when it can, which is also every
 * caller's test for whether to offer the action at all.
 *
 * The advice depends on where the collection is DECLARED, not on where it
 * lives, and `descriptorLocation` carries a distinct reason for each case
 * precisely so the copy can differ: telling the operator of a
 * `bruno.collections[]` entry — or the user who added one from the Bruno
 * dashboard — to edit a `catalog-info.yaml` sends them looking for a file that
 * does not exist.
 *
 * A hook rather than a component because the answer is what the surrounding
 * dialog or card branches on, and it needs the SCM integrations to give it —
 * `useApiHolder` rather than `useApi`, since a host app is not obliged to
 * register that API and `useApi` throws at render time for a missing one.
 *
 * Holding it in one place is what keeps the link, unlink and empty-card copy
 * describing the same five situations the same way.
 */
export function useDescriptorAdvice(opts: {
  location: DescriptorLocation;
  /** The API reference being added or removed, once one is known. */
  apiRef?: string;
  direction: PartOfDirection;
  /**
   * The collection's current `spec.partOf`.
   *
   * Optional, and the whole difference between showing the finished YAML and
   * only describing it: without it the edit cannot be computed, so the caller
   * that does not know which collection is in play yet gets the prose. Passed
   * by the two dialogs that have both a collection and a reference.
   */
  currentPartOf?: unknown;
  /** Applied to the notice or paragraph, for the caller's spacing. */
  className?: string;
}): JSX.Element | undefined {
  const { location, apiRef, direction, currentPartOf, className } = opts;
  const scmIntegrations = useApiHolder().get(scmIntegrationsApiRef);
  const classes = useStyles();
  const { Verb, verb, preposition } = WORDING[direction];
  // The advice is descriptor-level, so it is also worth saying BEFORE an API
  // has been picked — and then it has to name the reference generically.
  const ref = apiRef
    ? <code>{apiRef}</code>
    : <>the API&apos;s entity reference</>;

  if (location.kind === 'url') {
    if (prSupported(location.target, scmIntegrations)) {
      return undefined;
    }
    /**
     * The floor: the finished edit, on any host.
     *
     * A descriptor here really is a file in source control that really does
     * need one list changed, and the only thing this app cannot do on a
     * Bitbucket, Gerrit or Harness host is COMMIT it. Working the edit out is
     * pure string work (`lib/unlinkPr.ts#partOfSnippet`), so the answer is the
     * YAML and the exact path, not a description of them — which is what this
     * used to give, and which left the reader to re-derive by hand the one
     * thing the flow already knew.
     *
     * `snippet` is undefined only where the edit genuinely cannot be computed —
     * before an API has been picked, or where the caller has no collection in
     * hand — and the prose below is then the honest fallback rather than the
     * default.
     */
    const snippet
      = apiRef !== undefined
        ? partOfSnippet({ direction, current: currentPartOf, apiRefs: [apiRef] })
        : undefined;
    // `''` for a URL shape no forge grammar recognises, where the descriptor's
    // own URL is the best identification available.
    const path = collectionPathFromUrl(location.target);
    const where = path
      ? <code>{path}</code>
      : <Link to={location.target}>{location.target}</Link>;

    if (snippet?.outcome === 'replace') {
      return (
        <Box className={className}>
          <Typography variant="body2">
            Pull requests are not supported on this host, so this one edit is
            yours to commit. In {where}, <code>spec.partOf</code> should read as
            below — the <code>spec:</code> line is there to fix the indentation,
            not to replace the rest of your <code>spec</code>.
          </Typography>
          <Box className={classes.snippet}>
            <CodeSnippet text={snippet.yaml} language="yaml" showCopyCodeButton />
          </Box>
        </Box>
      );
    }
    if (snippet?.outcome === 'remove-key') {
      return (
        <Typography variant="body2" className={className}>
          Pull requests are not supported on this host, so this one edit is
          yours to commit. In {where}, {ref} is the only entry in{' '}
          <code>spec.partOf</code>, so remove the whole <code>partOf</code> key.
        </Typography>
      );
    }
    if (snippet?.outcome === 'none') {
      return (
        <Typography variant="body2" color="error" className={className}>
          {snippet.message}
        </Typography>
      );
    }
    return (
      <Typography variant="body2" color="error" className={className}>
        Pull requests are not supported on this host. In {where}, {verb} {ref}{' '}
        {preposition} the <code>spec.partOf</code> list yourself
        {direction === 'unlink' && (
          <>
            {' '}(and drop the <code>partOf</code> key entirely if it empties)
          </>
        )}
        .
      </Typography>
    );
  }

  if (location.reason === 'provider') {
    // A `bruno.collections[]` entry: the provider stamps the collection FOLDER
    // as the managed-by-location, so there is no descriptor file anywhere.
    return (
      <InlineNotice className={className}>
        Declared by <code>bruno.collections[]</code> in{' '}
        <code>app-config.yaml</code>, so there is no descriptor to open a pull
        request against. {Verb} {ref} {preposition} that entry&apos;s{' '}
        <code>partOf</code> list and restart Backstage.
      </InlineNotice>
    );
  }

  if (location.reason === 'ui') {
    // Added from the Bruno dashboard: the entity comes from a row in the
    // `bruno` backend's store, and `BrunoCollectionEntityProvider` stamps the
    // collection FOLDER as its location — so there is no more a descriptor here
    // than there is for a `bruno.collections[]` entry, and this used to be read
    // as one.
    //
    // This used to end "remove the collection from the dashboard and add it
    // again with the APIs you want", which was the only answer while a stored
    // row's `partOf` was fixed at creation. It has not been since runtime links
    // arrived, and the advice then sat directly above the radio button that
    // does the job in one click — recommending that a user destroy and
    // re-create an entity to avoid pressing the control beneath it. What the
    // notice says now is only what is still true of the descriptor: there is
    // none, and here is how to get one. Where the link can go INSTEAD is the
    // job of the control that offers it (`LinkMethodChoice`, and the empty
    // state in `RelatedApisCard`), which is also the only place that knows
    // whether `bruno.allowRuntimeWrites` allows it.
    return (
      <InlineNotice className={className}>
        Added from the Bruno dashboard, so what declares this collection is a
        record Backstage keeps rather than a <code>catalog-info.yaml</code> —
        there is no descriptor to open a pull request against. To manage{' '}
        <code>spec.partOf</code> in source control instead, commit a{' '}
        <code>catalog-info.yaml</code> declaring this collection, register it as
        a catalog location, and remove the dashboard&apos;s copy — two sources
        claiming one entity name leaves the second silently doing nothing.
      </InlineNotice>
    );
  }

  if (location.reason === 'file') {
    return (
      <InlineNotice className={className}>
        Registered from a local file on the Backstage host&apos;s disk, not from
        source control. {Verb} {ref} {preposition} its{' '}
        <code>spec.partOf</code> in that file directly.
      </InlineNotice>
    );
  }

  if (location.reason === 'discovery') {
    // Discovered by `bruno.discovery[]`: no descriptor, and no config entry to
    // edit either — the entity is re-derived from the repository every tick.
    return (
      <Typography variant="body2" color="error" className={className}>
        This collection was discovered in its repository by{' '}
        <code>bruno.discovery</code>, so it has neither a{' '}
        <code>catalog-info.yaml</code> nor a <code>bruno.collections[]</code>{' '}
        entry to edit — its links are re-derived from source control on every
        refresh. Author a <code>catalog-info.yaml</code> declaring{' '}
        <code>kind: Bruno</code> in that repository, which discovery then leaves
        to that descriptor, and manage <code>spec.partOf</code> there.
      </Typography>
    );
  }

  return (
    <Typography variant="body2" color="error" className={className}>
      This collection carries no <code>backstage.io/managed-by-location</code>,
      so the file that declares it cannot be identified.
    </Typography>
  );
}
