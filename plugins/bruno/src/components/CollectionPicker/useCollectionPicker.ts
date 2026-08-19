import { useEffect, useRef, useState } from 'react';
import { useApi, githubAuthApiRef } from '@backstage/core-plugin-api';
import { brunoApiRef } from '../../api/BrunoApi';
import type { ConnectResult, DiscoveredCollection } from '../../api/types';
import { emitConnectionChange } from '../../lib/connectionEvents';
import { classifyLinkError } from '../../lib/linkErrors';

export type State
  = | { status: 'idle' }
    | { status: 'scanning' }
    | { status: 'needsGithubScan' }
    | { status: 'scanned'; collections: DiscoveredCollection[] }
    | { status: 'noCollections' }
    | { status: 'connecting' }
    | { status: 'needsGithubLink' }
    | { status: 'notFound' }
    | { status: 'linked' }
    | { status: 'error'; errorMsg: string };

export interface UseCollectionPickerOptions {
  entityRef?: string;
  initialUrl?: string;
  mode?: 'single';
  onLinked: (result: ConnectResult) => void | Promise<void>;
}

export interface CollectionPickerApi {
  state: State;
  url: string;
  setUrl: (v: string) => void;
  urlError?: string;
  selectedCollectionId: string;
  setSelectedCollectionId: (id: string) => void;
  scan: (overrideUrl?: string) => Promise<void>;
  scanWithGithub: () => Promise<void>;
  link: () => Promise<void>;
  linkWithGithub: () => Promise<void>;
  reset: (nextUrl?: string) => void;
}

/**
 * The shared SCAN → pick → LINK state machine, including the gesture-safe OAuth
 * flow. `scan`/`link` try a silent (`{ optional: true }`) token first so an
 * already-connected GitHub session works with no popup; `scanWithGithub`/
 * `linkWithGithub` are the explicit gesture paths whose popup-opening
 * `getAccessToken(['repo'])` MUST be the first await of the click handler.
 */
export function useCollectionPicker(
  options: UseCollectionPickerOptions
): CollectionPickerApi {
  const { entityRef, initialUrl, onLinked } = options;
  const brunoApi = useApi(brunoApiRef);
  const githubAuth = useApi(githubAuthApiRef);

  const [state, setState] = useState<State>({ status: 'idle' });
  const [url, setUrl] = useState(initialUrl ?? '');
  const [urlError, setUrlError] = useState<string | undefined>();
  const [selectedCollectionId, setSelectedCollectionId] = useState('');
  // Guards against concurrent/double submissions (each triggers a real backend
  // fetch and, on the private path, an OAuth popup).
  const inFlight = useRef(false);
  // Holds the user OAuth token from a private scan so the subsequent LINK can
  // reuse it without a second consent popup. Never logged.
  const scanTokenRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    setState({ status: 'idle' });
    setUrl(initialUrl ?? '');
    setUrlError(undefined);
    setSelectedCollectionId('');
    inFlight.current = false;
    scanTokenRef.current = undefined;
    // Reset whenever the link target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityRef]);

  const validateUrl = (value: string): string | undefined => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return 'Enter a valid URL.';
    }
    if (!parsed.hostname.includes('github')) {
      return 'Enter a GitHub repository URL.';
    }
    if (parsed.pathname.includes('/blob/')) {
      return 'Enter a repository URL, not a file (/blob/) URL.';
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
      return 'URL must include owner and repository (owner/repo).';
    }
    return undefined;
  };

  // Connects a single discovered collection without a fresh user gesture,
  // reusing the token already held for the running scan. Called only from inside
  // scan/scanWithGithub, so `inFlight.current` is still true (the enclosing
  // `finally` owns it) and no new first-await is introduced — never calls
  // `getAccessToken`.
  const autoLink = async (
    chosen: DiscoveredCollection,
    token?: string
  ) => {
    if (!entityRef) {
      return;
    }
    setState({ status: 'connecting' });
    try {
      const result = await brunoApi.connect(entityRef, chosen.sourceUrl, token);
      setState({ status: 'linked' });
      emitConnectionChange(entityRef);
      await onLinked(result);
    } catch (e) {
      // Ambiguous 404: only "not found" if a token was actually in play
      // (see `scan`); without one, fall through to the Connect GitHub gate.
      if (scanTokenRef.current && classifyLinkError(e) === 'notFound') {
        setState({ status: 'notFound' });
      } else if (scanTokenRef.current) {
        setState({
          status: 'error',
          errorMsg: e instanceof Error ? e.message : String(e)
        });
      } else {
        setState({ status: 'needsGithubLink' });
      }
    }
  };

  // Resolves a scan result: 0 roots → nothing to link; 1 → auto-link with the
  // token from the current scan; >1 → show the picker with LINK disabled until
  // the user chooses.
  const resolveScan = async (
    collections: DiscoveredCollection[],
    token?: string
  ) => {
    if (collections.length === 0) {
      setSelectedCollectionId('');
      setState({ status: 'noCollections' });
      return;
    }
    if (collections.length === 1) {
      setSelectedCollectionId(collections[0].collectionId);
      await autoLink(collections[0], token);
      return;
    }
    setSelectedCollectionId('');
    setState({ status: 'scanned', collections });
  };

  // Step 1: silent-token path. The FIRST await is an optional token fetch that
  // never opens a popup (returns '' when there's no session). A live token is
  // reused for a private repo with no popup; otherwise we try unauthenticated
  // and, on failure, surface the explicit "Connect GitHub" action.
  const scan = async (overrideUrl?: string) => {
    if (inFlight.current || !entityRef) {
      return;
    }
    // `overrideUrl` lets a caller (e.g. "Change collection") scan a URL it just
    // computed without waiting for the `setUrl` state update to flush.
    const trimmed = (overrideUrl ?? url).trim();
    const validationError = validateUrl(trimmed);
    if (validationError) {
      setUrlError(validationError);
      return;
    }
    setUrlError(undefined);
    inFlight.current = true;
    setState({ status: 'scanning' });
    try {
      const token = await githubAuth.getAccessToken(['repo'], {
        optional: true
      });
      let result;
      if (token) {
        scanTokenRef.current = token;
        result = await brunoApi.discover(trimmed, token);
      } else {
        scanTokenRef.current = undefined;
        result = await brunoApi.discover(trimmed);
      }
      await resolveScan(result.collections, token || undefined);
    } catch (e) {
      // A 404 without a token is ambiguous: GitHub returns 404 for a private
      // repo the anonymous read can't see, not just for a genuinely missing
      // one. Only treat it as "not found" once we actually used a token;
      // otherwise offer the Connect GitHub path so private repos stay reachable.
      if (scanTokenRef.current && classifyLinkError(e) === 'notFound') {
        setState({ status: 'notFound' });
      } else {
        setState({ status: 'needsGithubScan' });
      }
    } finally {
      inFlight.current = false;
    }
  };

  // Step 1 (private): fired directly from the "Connect GitHub" button so the
  // OAuth popup opens within the user gesture. `getAccessToken` MUST be the
  // first await — it opens the consent popup when GitHub isn't connected and
  // rejects if the user declines. The token is held for the subsequent LINK.
  const scanWithGithub = async () => {
    if (inFlight.current || !entityRef) {
      return;
    }
    inFlight.current = true;
    const trimmed = url.trim();
    try {
      let token: string;
      try {
        token = await githubAuth.getAccessToken(['repo']);
      } catch {
        setState({
          status: 'error',
          errorMsg: 'GitHub access needed for private repos — Connect GitHub.'
        });
        return;
      }
      scanTokenRef.current = token;
      setState({ status: 'scanning' });
      const result = await brunoApi.discover(trimmed, token);
      await resolveScan(result.collections, token);
    } catch (e) {
      if (classifyLinkError(e) === 'notFound') {
        setState({ status: 'notFound' });
      } else {
        setState({
          status: 'error',
          errorMsg: e instanceof Error ? e.message : String(e)
        });
      }
    } finally {
      inFlight.current = false;
    }
  };

  // Step 2: link the chosen collection. Reuses the private-scan token if any;
  // otherwise tops up with a silent (`optional`) token as the first await (no
  // popup). If the link fails without a token, the repo likely needs GitHub
  // access — surface the Connect GitHub action.
  const link = async () => {
    if (inFlight.current || !entityRef || state.status !== 'scanned') {
      return;
    }
    const chosen = state.collections.find(
      (c) => c.collectionId === selectedCollectionId
    );
    if (!chosen) {
      return;
    }
    inFlight.current = true;
    setState({ status: 'connecting' });
    try {
      let token = scanTokenRef.current;
      if (!token) {
        token
          = (await githubAuth.getAccessToken(['repo'], { optional: true }))
            || undefined;
        scanTokenRef.current = token;
      }
      const result = await brunoApi.connect(entityRef, chosen.sourceUrl, token);
      setState({ status: 'linked' });
      if (entityRef) {
        emitConnectionChange(entityRef);
      }
      await onLinked(result);
    } catch (e) {
      // Ambiguous 404: only "not found" if a token was actually in play
      // (see `scan`); without one, fall through to the Connect GitHub gate.
      if (scanTokenRef.current && classifyLinkError(e) === 'notFound') {
        setState({ status: 'notFound' });
      } else if (scanTokenRef.current) {
        setState({
          status: 'error',
          errorMsg: e instanceof Error ? e.message : String(e)
        });
      } else {
        setState({ status: 'needsGithubLink' });
      }
    } finally {
      inFlight.current = false;
    }
  };

  // Fired from the "Connect GitHub" button after a link failed without a token.
  // `getAccessToken` MUST be the first await so the popup stays within the click
  // gesture. The token is reused for the retry.
  const linkWithGithub = async () => {
    if (inFlight.current || !entityRef || state.status !== 'needsGithubLink') {
      return;
    }
    inFlight.current = true;
    try {
      let token: string;
      try {
        token = await githubAuth.getAccessToken(['repo']);
      } catch {
        setState({
          status: 'error',
          errorMsg: 'GitHub access needed for private repos — Connect GitHub.'
        });
        return;
      }
      scanTokenRef.current = token;
      // Re-scan with the token so we have the chosen collection's github URL,
      // then link it. The scan is cheap and keeps the chosen path valid.
      const trimmed = url.trim();
      setState({ status: 'connecting' });
      const result = await brunoApi.discover(trimmed, token);
      const chosen = result.collections.find(
        (c) => c.collectionId === selectedCollectionId
      );
      if (!chosen) {
        setState({
          status: 'error',
          errorMsg:
            'The selected collection was no longer found on re-scan. '
            + 'Please scan again and pick a collection.'
        });
        return;
      }
      const linked = await brunoApi.connect(
        entityRef,
        chosen.sourceUrl,
        token
      );
      setState({ status: 'linked' });
      if (entityRef) {
        emitConnectionChange(entityRef);
      }
      await onLinked(linked);
    } catch (e) {
      if (classifyLinkError(e) === 'notFound') {
        setState({ status: 'notFound' });
      } else {
        setState({
          status: 'error',
          errorMsg: e instanceof Error ? e.message : String(e)
        });
      }
    } finally {
      inFlight.current = false;
    }
  };

  const reset = (nextUrl?: string) => {
    setState({ status: 'idle' });
    setUrl(nextUrl ?? '');
    setUrlError(undefined);
    setSelectedCollectionId('');
    inFlight.current = false;
    scanTokenRef.current = undefined;
  };

  return {
    state,
    url,
    setUrl,
    urlError,
    selectedCollectionId,
    setSelectedCollectionId,
    scan,
    scanWithGithub,
    link,
    linkWithGithub,
    reset
  };
}
