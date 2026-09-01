import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Button from '@material-ui/core/Button';
import AddIcon from '@material-ui/icons/Add';
import { useApi } from '@backstage/core-plugin-api';
import { brunoApiRef } from '../../api';
import type { CreatedCollection } from '../../api';
import { announceCollectionCreated } from '../../lib/collectionEvents';
import { useBrandStyles } from '../../theme/brandStyles';
import { AddCollectionDialog } from './AddCollectionDialog';
import { GeneratedYamlDialog } from './GeneratedYamlDialog';
import type { BrunoEntityInput } from './generateCatalogInfo';
import { buildBrunoEntity, toCatalogInfoYaml } from './generateCatalogInfo';

/** The query parameters that open this flow from elsewhere in the app. */
const OPEN_PARAM = 'add';
const PART_OF_PARAM = 'partOf';

/**
 * Where the two-modal flow is.
 *
 * One state rather than the two independent `open`/`generated` flags this used
 * to carry, because the create introduced a stage that is neither: modal 1 is
 * open, the user cannot touch it, and there is nothing to show in modal 2 yet.
 * With two booleans that stage is representable only as "both closed" or "both
 * open", and both of those render something wrong.
 */
type Flow
  = | { status: 'closed' }
    | { status: 'form'; error?: string }
    | { status: 'creating' }
    | {
      status: 'created';
      input: BrunoEntityInput;
      yaml: string;
      created: CreatedCollection;
    };

/**
 * The `Add Bruno Collection` header action, and the two-modal flow behind it.
 *
 * Both modals live here rather than nesting the second inside the first, because
 * the PRD's flow is a hand-off: modal 1 closes AS modal 2 opens. A nested dialog
 * would either stack two backdrops or keep modal 1 mounted underneath, and the
 * generated descriptor has to outlive the form that produced it — the user is
 * meant to sit with the YAML, download it, edit a pull request title, and none
 * of that should be happening on top of a form they have finished with.
 *
 * The hand-off is no longer instant, and that is what the `creating` stage is
 * for. Submitting modal 1 now CREATES the collection, so there is a round trip
 * that can fail, and the one that fails most often is a name someone else has
 * already used. Modal 1 therefore stays open and disabled while the create is in
 * flight and comes back with the error attached, so a rejected name lands on the
 * field that produced it with everything else still filled in. Closing modal 1
 * on submit and reporting the failure somewhere else would leave the user
 * retyping a form they had already completed.
 *
 * The deep link is the other half of the contract. An API entity page's "Add a
 * new Bruno Collection" button cannot open a dialog that lives on another route,
 * so it navigates to `/bruno?add=1&partOf=<api ref>` and this reads those back.
 * The parameters are CONSUMED on open — stripped from the URL — so that a
 * browser reload, or a back-navigation after the flow finished, does not
 * silently reopen the dialog over the dashboard.
 */
export function AddCollectionAction(): JSX.Element {
  const brandClasses = useBrandStyles();
  const brunoApi = useApi(brunoApiRef);
  const [searchParams, setSearchParams] = useSearchParams();

  const [flow, setFlow] = useState<Flow>({ status: 'closed' });
  const [initialPartOf, setInitialPartOf] = useState<string | undefined>();

  useEffect(() => {
    if (!searchParams.has(OPEN_PARAM)) {
      return;
    }
    setInitialPartOf(searchParams.get(PART_OF_PARAM) ?? undefined);
    setFlow({ status: 'form' });

    // Built from `window.location.search`, NOT from the router's `searchParams`.
    // The dashboard's `EntityListProvider` writes its filter state to the query
    // string with a raw `window.history.replaceState` rather than through the
    // router (useEntityListProvider.esm.js:198), so the router's copy can be
    // missing filters that are really in the address bar — and stripping our two
    // parameters must not take those with it.
    const next = new URLSearchParams(window.location.search);
    next.delete(OPEN_PARAM);
    next.delete(PART_OF_PARAM);
    // `replace`, so arriving here from an API page does not leave a history
    // entry that re-opens the dialog when the user clicks back.
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  /**
   * Creates the collection, and reports back whether modal 1 may empty itself.
   *
   * The boolean return is the whole contract with {@link AddCollectionDialog}:
   * it clears its fields only on `true`. Anything richer (an error prop it
   * watches, a submit counter) would have the dialog inferring success from a
   * state transition, and the transition it would be watching is the one that
   * does not happen when the create is rejected.
   */
  const onSubmit = useCallback(
    async (input: BrunoEntityInput): Promise<boolean> => {
      setFlow({ status: 'creating' });
      try {
        const created = await brunoApi.createCollection({
          name: input.name,
          url: input.url,
          partOf: input.partOf,
          owner: input.owner
        });
        setFlow({
          status: 'created',
          input,
          // Serialised once, here, so the preview, the download and the pull
          // request all read the same string. See `generateCatalogInfo.ts`.
          yaml: toCatalogInfoYaml(buildBrunoEntity(input)),
          created
        });
        // Tells the dashboard's pending strip to look now. It is mounted by a
        // different extension, so there is no context to hand this to; and the
        // create it needs to hear about is exactly the event that changes
        // nothing it already watches — the catalog has no new entity yet. Sent
        // after the state is set, and never awaited: a dashboard that is not
        // open has no listener, and losing it costs the strip some latency,
        // never correctness. See `lib/collectionEvents.ts`.
        announceCollectionCreated();
        return true;
      } catch (e) {
        setFlow({
          status: 'form',
          error: e instanceof Error ? e.message : String(e)
        });
        return false;
      }
    },
    [brunoApi]
  );

  return (
    <>
      <Button
        variant="contained"
        className={brandClasses.accentButton}
        startIcon={<AddIcon />}
        onClick={() => {
          setInitialPartOf(undefined);
          setFlow({ status: 'form' });
        }}
      >
        Add Bruno Collection
      </Button>

      <AddCollectionDialog
        open={flow.status === 'form' || flow.status === 'creating'}
        initialPartOf={initialPartOf}
        submitting={flow.status === 'creating'}
        error={flow.status === 'form' ? flow.error : undefined}
        onClose={() => setFlow({ status: 'closed' })}
        onSubmit={onSubmit}
      />

      {flow.status === 'created' && (
        <GeneratedYamlDialog
          open
          collectionUrl={flow.input.url}
          name={flow.input.name}
          yaml={flow.yaml}
          entityRef={flow.created.entityRef}
          refreshSeconds={flow.created.refreshSeconds}
          onClose={() => setFlow({ status: 'closed' })}
        />
      )}
    </>
  );
}
