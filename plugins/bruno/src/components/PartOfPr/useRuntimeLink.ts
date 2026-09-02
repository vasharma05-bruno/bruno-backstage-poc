import { useState } from 'react';
import { useApi } from '@backstage/core-plugin-api';
import { brunoApiRef } from '../../api';

/**
 * The machinery behind a link that is NOT a pull request: the stage a flow is
 * in, and the two calls into the `bruno` backend's link table.
 *
 * The counterpart of {@link usePartOfPr}, and deliberately its own hook rather
 * than another branch inside it. The two flows share a shape at the top — a
 * stage, a reset, an action — and nothing below it: this one has no credential
 * dance (the identity token is on the `fetchApi` already), no plan, and no
 * preview, because no file changes and there is nothing to diff. Folding it
 * into `usePartOfPr` would mean a `plan` that is sometimes absent and a
 * `preview` stage that is sometimes unreachable, which is how a state machine
 * stops being readable.
 *
 * There is no `preparing` step for the same reason. What the user is agreeing
 * to is not a diff, it is WHERE the link lives — stated on the method chooser
 * before the click, not in a confirmation after it.
 */
export type RuntimeStage
  = | { status: 'idle' }
    | { status: 'working' }
    | {
      /** The write landed. `linked` and `unlinked` read the same to this
       *  hook and completely differently to a dialog, so they stay apart. */
      status: 'linked' | 'unlinked';
      /**
       * Whether the backend managed to schedule an immediate reprocess, and so
       * whether the relation is seconds or a full catalog cycle away. Reported
       * rather than assumed: a dialog that promises "a few seconds" and then
       * sits there for five minutes is worse than one that says which it is.
       */
      refreshRequested: boolean;
    }
    | { status: 'error'; message: string };

export interface RuntimeLink {
  stage: RuntimeStage;
  /** Back to the dialog's first step, discarding any error. */
  reset: () => void;
  /**
   * Writes the rows for one collection and several APIs — all of them or none.
   * They land in the same `partOf`, so one call is one refresh.
   */
  link: (opts: {
    collectionRef: string;
    apiRefs: string[];
    onLinked?: (refreshRequested: boolean) => void;
  }) => void;
  /** Removes one row. Unlinking is a per-row action, so it is never plural. */
  unlink: (opts: {
    collectionRef: string;
    apiRef: string;
    onUnlinked?: (refreshRequested: boolean) => void;
  }) => void;
}

export function useRuntimeLink(): RuntimeLink {
  const brunoApi = useApi(brunoApiRef);
  const [stage, setStage] = useState<RuntimeStage>({ status: 'idle' });

  const fail = (e: unknown): void =>
    setStage({
      status: 'error',
      message: e instanceof Error ? e.message : String(e)
    });

  return {
    stage,
    reset: () => setStage({ status: 'idle' }),
    // The callbacks are passed per call rather than held in the hook, so they
    // always see the selection the click was made against — the same reason
    // `usePartOfPr.submit` takes its `onSubmitted` that way.
    link: ({ collectionRef, apiRefs, onLinked }) => {
      setStage({ status: 'working' });
      brunoApi
        .createRuntimeLinks({ collectionRef, apiRefs })
        .then((result) => {
          setStage({
            status: 'linked',
            refreshRequested: result.refreshRequested
          });
          onLinked?.(result.refreshRequested);
        })
        .catch(fail);
    },
    unlink: ({ collectionRef, apiRef, onUnlinked }) => {
      setStage({ status: 'working' });
      brunoApi
        .deleteRuntimeLink({ collectionRef, apiRef })
        .then((result) => {
          setStage({
            status: 'unlinked',
            refreshRequested: result.refreshRequested
          });
          onUnlinked?.(result.refreshRequested);
        })
        .catch(fail);
    }
  };
}
