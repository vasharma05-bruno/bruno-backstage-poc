import { useEffect, useRef, useState } from 'react';
import { useApi } from '@backstage/core-plugin-api';
import { brunoApiRef } from '../../api/BrunoApi';
import type { ConnectResult, DiscoveredCollection } from '../../api/types';
import { emitConnectionChange } from '../../lib/connectionEvents';
import { classifyLinkError } from '../../lib/linkErrors';
import { scmProviderLabel, validateScmRepoUrl } from '../../lib/scmProviders';
import { useScmToken } from '../../lib/useScmToken';

export type State
  = | { status: 'idle' }
    | { status: 'scanning' }
    | { status: 'needsAuthScan' }
    | { status: 'scanned'; collections: DiscoveredCollection[] }
    | { status: 'noCollections' }
    | { status: 'connecting' }
    | { status: 'needsAuthLink' }
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
  /**
   * Display name of the SCM provider for the URL currently entered ('GitHub',
   * 'GitLab', 'Bitbucket'), for host-side button and message copy. Falls back to
   * a neutral phrase for an empty or unrecognized URL.
   */
  providerLabel: string;
  scan: (overrideUrl?: string) => Promise<void>;
  scanWithAuth: () => Promise<void>;
  link: () => Promise<void>;
  linkWithAuth: () => Promise<void>;
  reset: (nextUrl?: string) => void;
}

/**
 * The shared SCAN → pick → LINK state machine, including the gesture-safe OAuth
 * flow. `scan`/`link` try a silent token first so an already-connected SCM
 * session works with no popup; `scanWithAuth`/`linkWithAuth` are the explicit
 * gesture paths whose popup-opening `tokens.interactive(url)` MUST be the first
 * await of the click handler.
 *
 * Provider-agnostic: which OAuth provider is used follows from the URL's host
 * (see `useScmToken`), so GitHub, GitLab and Bitbucket all take the same path
 * through this machine.
 */
export function useCollectionPicker(
  options: UseCollectionPickerOptions
): CollectionPickerApi {
  const { entityRef, initialUrl, onLinked } = options;
  const brunoApi = useApi(brunoApiRef);
  const tokens = useScmToken();

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

  // A provider/configuration failure is TERMINAL: no token and no amount of
  // OAuth consent can fix "this host has no integration configured" or "this
  // provider cannot use your token". Surface its message rather than the connect
  // gate (which would loop) or the not-found copy (which would bury it).
  const terminalError = (e: unknown) => ({
    status: 'error' as const,
    errorMsg: e instanceof Error ? e.message : String(e)
  });

  // Connects a single discovered collection without a fresh user gesture,
  // reusing the token already held for the running scan. Called only from inside
  // scan/scanWithAuth, so `inFlight.current` is still true (the enclosing
  // `finally` owns it) and no new first-await is introduced — it never requests
  // a token itself.
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
      const kind = classifyLinkError(e);
      // Ambiguous 404: only "not found" if a token was actually in play
      // (see `scan`); without one, fall through to the connect gate.
      if (kind === 'configError') {
        setState(terminalError(e));
      } else if (scanTokenRef.current && kind === 'notFound') {
        setState({ status: 'notFound' });
      } else if (scanTokenRef.current) {
        setState(terminalError(e));
      } else {
        setState({ status: 'needsAuthLink' });
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
  // never opens a popup (yields undefined when there's no session, no registered
  // SCM auth API, or no provider for this host). A live token is reused for a
  // private repo with no popup; otherwise we try unauthenticated and, on
  // failure, surface the explicit "Connect <provider>" action.
  const scan = async (overrideUrl?: string) => {
    if (inFlight.current || !entityRef) {
      return;
    }
    // `overrideUrl` lets a caller (e.g. "Change collection") scan a URL it just
    // computed without waiting for the `setUrl` state update to flush.
    const trimmed = (overrideUrl ?? url).trim();
    const validationError = validateScmRepoUrl(trimmed);
    if (validationError) {
      setUrlError(validationError);
      return;
    }
    setUrlError(undefined);
    inFlight.current = true;
    setState({ status: 'scanning' });
    try {
      const token = await tokens.silent(trimmed);
      let result;
      if (token) {
        scanTokenRef.current = token;
        result = await brunoApi.discover(trimmed, token);
      } else {
        scanTokenRef.current = undefined;
        result = await brunoApi.discover(trimmed);
      }
      await resolveScan(result.collections, token);
    } catch (e) {
      // A 404/403 without a token is ambiguous: every provider hides a private
      // repo behind a "missing" response of some kind (GitHub 404s, GitLab 404s
      // on hidden projects and 403s elsewhere, Bitbucket 403s). Only treat it as
      // "not found" once we actually used a token; otherwise offer the connect
      // path so private repos stay reachable.
      //
      // With a token already in play, anything that is NOT a "not found" is a
      // real failure and its message is the useful thing to show — offering the
      // connect gate again would loop the user through a popup that cannot help.
      // That is the path a private Bitbucket Cloud repo takes, since its reader
      // cannot use a per-user token at all. Mirrors `link` below.
      const kind = classifyLinkError(e);
      if (kind === 'configError') {
        setState(terminalError(e));
      } else if (scanTokenRef.current) {
        setState(
          kind === 'notFound'
            ? { status: 'notFound' }
            : terminalError(e)
        );
      } else {
        setState({ status: 'needsAuthScan' });
      }
    } finally {
      inFlight.current = false;
    }
  };

  // Step 1 (private): fired directly from the "Connect <provider>" button so the
  // OAuth popup opens within the user gesture. `tokens.interactive` MUST be the
  // first await — it opens the consent popup when the provider isn't connected
  // and rejects if the user declines. The token is held for the subsequent LINK.
  const scanWithAuth = async () => {
    if (inFlight.current || !entityRef) {
      return;
    }
    inFlight.current = true;
    const trimmed = url.trim();
    try {
      let token: string;
      try {
        token = await tokens.interactive(trimmed);
      } catch (e) {
        setState({ status: 'error', errorMsg: connectErrorMessage(trimmed, e) });
        return;
      }
      scanTokenRef.current = token;
      setState({ status: 'scanning' });
      const result = await brunoApi.discover(trimmed, token);
      await resolveScan(result.collections, token);
    } catch (e) {
      setState(
        classifyLinkError(e) === 'notFound'
          ? { status: 'notFound' }
          : terminalError(e)
      );
    } finally {
      inFlight.current = false;
    }
  };

  // Step 2: link the chosen collection. Reuses the private-scan token if any;
  // otherwise tops up with a silent token as the first await (no popup). If the
  // link fails without a token, the repo likely needs the user's own SCM
  // access — surface the connect action.
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
        token = await tokens.silent(chosen.sourceUrl);
        scanTokenRef.current = token;
      }
      const result = await brunoApi.connect(entityRef, chosen.sourceUrl, token);
      setState({ status: 'linked' });
      if (entityRef) {
        emitConnectionChange(entityRef);
      }
      await onLinked(result);
    } catch (e) {
      const kind = classifyLinkError(e);
      // Ambiguous 404: only "not found" if a token was actually in play
      // (see `scan`); without one, fall through to the connect gate.
      if (kind === 'configError') {
        setState(terminalError(e));
      } else if (scanTokenRef.current && kind === 'notFound') {
        setState({ status: 'notFound' });
      } else if (scanTokenRef.current) {
        setState(terminalError(e));
      } else {
        setState({ status: 'needsAuthLink' });
      }
    } finally {
      inFlight.current = false;
    }
  };

  // Fired from the "Connect <provider>" button after a link failed without a
  // token. `tokens.interactive` MUST be the first await so the popup stays
  // within the click gesture. The token is reused for the retry.
  const linkWithAuth = async () => {
    if (inFlight.current || !entityRef || state.status !== 'needsAuthLink') {
      return;
    }
    inFlight.current = true;
    try {
      const trimmed = url.trim();
      let token: string;
      try {
        token = await tokens.interactive(trimmed);
      } catch (e) {
        setState({ status: 'error', errorMsg: connectErrorMessage(trimmed, e) });
        return;
      }
      scanTokenRef.current = token;
      // Re-scan with the token so we have the chosen collection's source URL,
      // then link it. The scan is cheap and keeps the chosen path valid.
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
      setState(
        classifyLinkError(e) === 'notFound'
          ? { status: 'notFound' }
          : terminalError(e)
      );
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
    providerLabel: scmProviderLabel(url),
    scan,
    scanWithAuth,
    link,
    linkWithAuth,
    reset
  };
}

/**
 * Message for a failed credential request. `tokens.interactive` rejects both
 * when the user declines consent and when the host registered no SCM auth API at
 * all — the second case carries an actionable message of its own, so pass it
 * through rather than flattening both into "access needed".
 */
function connectErrorMessage(url: string, e: unknown): string {
  const label = scmProviderLabel(url);
  const detail = e instanceof Error ? e.message : String(e);
  return detail.includes('No SCM authentication is configured')
    ? detail
    : `${label} access is needed for private repositories — connect ${label}.`;
}
