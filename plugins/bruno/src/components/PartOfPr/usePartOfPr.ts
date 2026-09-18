import { useState } from 'react';
import { useApiHolder } from '@backstage/core-plugin-api';
import { scmAuthApiRef, scmIntegrationsApiRef } from '@backstage/integration-react';
import type { PartOfDirection, PartOfPlan } from '../../lib/unlinkPr';
import { planLink, planUnlink, submitLink, submitUnlink } from '../../lib/unlinkPr';
import { prAdapterForUrl } from '../../lib/pr/registry';
import type { PrAdapter } from '../../lib/pr/types';

/**
 * The machinery every `spec.partOf` dialog runs on: the stage a flow is in, the
 * SCM token it needs, and the two calls into `lib/unlinkPr`.
 *
 * There are three of these dialogs — link from an API, link from a collection,
 * unlink — and only their COPY and their first step differ. What does not
 * differ is this: the same stage sequence, the same credential dance, the same
 * plan/submit pair. Holding it once is what keeps the three flows from drifting
 * apart the way three hand-maintained copies would.
 */
export type PartOfStage
  = | { status: 'idle' }
    | { status: 'planning' }
    | { status: 'preview'; plan: PartOfPlan }
    | { status: 'submitting'; plan: PartOfPlan }
    | { status: 'submitted'; link: string }
    | { status: 'error'; message: string };

export interface PartOfPr {
  stage: PartOfStage;
  /** Back to the dialog's first step, discarding any plan or error. */
  reset: () => void;
  /**
   * Reads the descriptor and composes the edit, writing nothing. Several
   * references go into ONE pull request: they all edit the same `spec.partOf`
   * in the same file, so a branch each would be noise.
   */
  prepare: (opts: { apiRefs: string[]; collectionName: string }) => void;
  /** Creates the branch, commits the descriptor and opens the pull request. */
  submit: (plan: PartOfPlan, onSubmitted?: (link: string) => void) => void;
}

export function usePartOfPr(opts: {
  direction: PartOfDirection;
  /** The collection's `catalog-info.yaml`, when it has one. */
  descriptorUrl: string | undefined;
}): PartOfPr {
  const { direction, descriptorUrl } = opts;
  // `useApiHolder` rather than `useApi`: a host app is not obliged to register
  // the SCM auth API, and `useApi` throws at RENDER time for a missing one —
  // which would take the whole card down instead of just blocking this action.
  const apis = useApiHolder();
  const scmAuth = apis.get(scmAuthApiRef);
  const integrations = apis.get(scmIntegrationsApiRef);

  const [stage, setStage] = useState<PartOfStage>({ status: 'idle' });

  const fail = (e: unknown): void =>
    setStage({
      status: 'error',
      message: e instanceof Error ? e.message : String(e)
    });

  /**
   * The token is read as the FIRST await of the click handler — the browser
   * treats an OAuth popup opened after any other await as unsolicited and blocks
   * it. It is held in a local for the length of the call, handed straight to the
   * adapter, and is never stored in state, logged, or put in a URL.
   *
   * The adapter is built per call rather than memoised for exactly that reason:
   * it closes over the token, so one that outlived the call would keep a
   * credential alive in component state.
   */
  const withAdapter = async (
    fn: (adapter: PrAdapter) => Promise<void>
  ): Promise<void> => {
    if (!scmAuth || !descriptorUrl) {
      fail(
        new Error(
          'No SCM authentication is configured in this Backstage app, so a pull '
          + 'request cannot be opened.'
        )
      );
      return;
    }
    try {
      const { token } = await scmAuth.getCredentials({
        url: descriptorUrl,
        additionalScope: { repoWrite: true }
      });
      if (!token) {
        throw new Error('The SCM provider returned no access token.');
      }
      const adapter = prAdapterForUrl({
        url: descriptorUrl,
        token,
        integrations
      });
      if (!adapter) {
        throw new Error(
          `No pull request can be opened against ${descriptorUrl}: its host `
          + 'matches no integration this plugin can write to.'
        );
      }
      await fn(adapter);
    } catch (e) {
      fail(e);
    }
  };

  return {
    stage,
    reset: () => setStage({ status: 'idle' }),
    prepare: ({ apiRefs, collectionName }) => {
      setStage({ status: 'planning' });
      void withAdapter(async (adapter) => {
        const plan = await (direction === 'link' ? planLink : planUnlink)({
          descriptorUrl: descriptorUrl as string,
          apiRefs,
          collectionName,
          adapter
        });
        setStage({ status: 'preview', plan });
      });
    },
    // `onSubmitted` is passed per call rather than held in the hook, so it
    // always sees the selection the click was made against.
    submit: (plan, onSubmitted) => {
      setStage({ status: 'submitting', plan });
      void withAdapter(async (adapter) => {
        const { link } = await (
          direction === 'link' ? submitLink : submitUnlink
        )(plan, adapter);
        setStage({ status: 'submitted', link });
        onSubmitted?.(link);
      });
    }
  };
}
