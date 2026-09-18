import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Button from '@material-ui/core/Button';
import AddIcon from '@material-ui/icons/Add';
import { useApi } from '@backstage/core-plugin-api';
import { brunoApiRef } from '../../api';
import { announceCollectionCreated } from '../../lib/collectionEvents';
import { useCanCreateCollection } from '../../lib/permissions';
import { useRuntimeWritesEnabled } from '../../lib/runtimeWrites';
import { useBrandStyles } from '../../theme/brandStyles';
import { AddCollectionDialog } from './AddCollectionDialog';
import { GeneratedYamlDialog } from './GeneratedYamlDialog';
import type { BrunoEntityInput } from './generateCatalogInfo';
import { buildBrunoEntity, toCatalogInfoYaml } from './generateCatalogInfo';

/** The query parameters that open this flow from elsewhere in the app. */
const OPEN_PARAM = 'add';
const PART_OF_PARAM = 'partOf';

/**
 * Where the flow is.
 *
 * `adding` and `descriptor` are the two ENDINGS the form offers, and they are
 * genuinely different shapes rather than two labels on one path:
 *
 *  - `adding` is a round trip. It registers the collection in the Bruno
 *    backend's store, so it can fail — most often on a name someone else has
 *    already used — and the form has to stay on screen, inert, until it knows.
 *    Success closes the whole flow; there is no second screen, because there is
 *    nothing left to tell the user that the dashboard's pending strip does not
 *    already say.
 *  - `descriptor` is not a round trip at all. It registers NOTHING; it
 *    serialises the form into a `catalog-info.yaml` and hands that to modal 2.
 *    So it cannot fail, cannot be rejected for a duplicate name, and carries no
 *    `entityRef` — the entity does not exist yet and will not until the
 *    descriptor is registered as a catalog location.
 *
 * One union rather than independent `open`/`generated` flags, because `adding`
 * is a stage that is neither: modal 1 is open, the user cannot touch it, and
 * there is nothing to show in modal 2 yet.
 */
type Flow
  = | { status: 'closed' }
    | { status: 'form'; error?: string }
    | { status: 'adding' }
    | { status: 'descriptor'; input: BrunoEntityInput; yaml: string };

/**
 * The `Add Bruno Collection` header action, and the flow behind it.
 *
 * The form ends in one of two ways, and the choice is the user's rather than
 * this component's:
 *
 *  - **Create pull request** (primary) generates the `catalog-info.yaml` and
 *    hands off to modal 2. The descriptor becomes the collection's only source
 *    of truth: nothing is written to the Bruno backend, so the catalog grows the
 *    entity when — and only when — that file is registered as a catalog
 *    location.
 *  - **Add collection** registers the collection with the backend and closes.
 *    The entity is materialised by `BrunoCollectionEntityProvider` within
 *    `bruno.schedule.frequencySeconds`, and the dashboard's pending strip is
 *    what reports the gap.
 *
 * The second ending exists only where `bruno.allowRuntimeWrites` is on. It is
 * the flow that makes this backend the source of truth for an entity, so an
 * instance that keeps source control authoritative gets the descriptor path
 * alone — and gets it as the plain, unqualified way to add a collection rather
 * than as one of two. The backend refuses the create either way; hiding it is
 * so the user never meets that refusal.
 *
 * The two are mutually exclusive on purpose. Doing both — which is what
 * submitting used to do — means two sources claiming one entity name: the
 * provider's `full` mutation and the descriptor's location, resolved by the
 * catalog first-writer-wins, so the merged descriptor silently does nothing.
 *
 * Both modals live here rather than nesting the second inside the first, because
 * the flow is a hand-off: modal 1 closes AS modal 2 opens. A nested dialog would
 * either stack two backdrops or keep modal 1 mounted underneath, and the
 * generated descriptor has to outlive the form that produced it — the user is
 * meant to sit with the YAML, download it, edit a pull request title, and none
 * of that should be happening on top of a form they have finished with.
 *
 * The deep link is the other half of the contract. An API entity page's "Add a
 * new Bruno Collection" button cannot open a dialog that lives on another route,
 * so it navigates to `/bruno?add=1&partOf=<api ref>` and this reads those back.
 * The parameters are CONSUMED on open — stripped from the URL — so that a
 * browser reload, or a back-navigation after the flow finished, does not
 * silently reopen the dialog over the dashboard.
 */
export function AddCollectionAction(props: {
  /**
   * Concrete path of the catalog's "Register an existing component" page,
   * passed straight through to {@link GeneratedYamlDialog}, which names it as
   * the step after the pull request.
   *
   * Resolved by whoever mounts this action rather than here, so the whole
   * component tree below stays free of a frontend-system-specific route hook —
   * see `src/extensions.tsx`.
   */
  catalogImportPath?: string;
}): JSX.Element {
  const { catalogImportPath } = props;
  const brandClasses = useBrandStyles();
  const brunoApi = useApi(brunoApiRef);
  const runtimeAvailable = useRuntimeWritesEnabled();
  const mayCreate = useCanCreateCollection();
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
   * Registers the collection, and reports back whether modal 1 may empty itself.
   *
   * The boolean return is the whole contract with {@link AddCollectionDialog}:
   * it clears its fields only on `true`. Anything richer (an error prop it
   * watches, a submit counter) would have the dialog inferring success from a
   * state transition, and the transition it would be watching is the one that
   * does not happen when the create is rejected.
   *
   * Closes the flow outright on success. The user is told nothing more here
   * because there is nowhere better to tell it: the collection is a stored row
   * that is not an entity yet, and the dashboard's pending strip — woken by the
   * event below — names it, times it against the provider's real tick, and
   * offers a Remove if it never lands. A modal repeating that would be a worse
   * copy of a screen the user is already looking at.
   */
  const onAdd = useCallback(
    async (input: BrunoEntityInput): Promise<boolean> => {
      setFlow({ status: 'adding' });
      try {
        await brunoApi.createCollection({
          name: input.name,
          // Field by field rather than spreading `input`, so the two shapes stay
          // independent — see `CreateCollectionInput`. `title` is passed through
          // as the dialog left it, `undefined` included: that is what makes the
          // stored row's title NULL and hands the display name back to the
          // collection manifest, exactly as omitting the key from the
          // descriptor does on the other ending.
          title: input.title,
          url: input.url,
          partOf: input.partOf,
          owner: input.owner
        });
        setFlow({ status: 'closed' });
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

  /**
   * Hands the form off to modal 2 as a descriptor.
   *
   * Synchronous, and deliberately not a promise: there is no backend call on
   * this path, so there is no failure for the dialog to wait on and no reason to
   * hold the form inert. It resets itself the moment this returns, exactly as it
   * does after a successful create.
   *
   * `announceCollectionCreated` is NOT called. Nothing was registered, so the
   * pending strip has nothing to report; waking it would have it read the
   * backend, find no new row, and render nothing — and the honest place for
   * "this is not in the catalog yet" is modal 2, which says so with the
   * descriptor on screen.
   */
  const onCreatePullRequest = useCallback((input: BrunoEntityInput): void => {
    setFlow({
      status: 'descriptor',
      input,
      // Serialised once, here, so the preview, the download and the pull
      // request all read the same string. See `generateCatalogInfo.ts`.
      yaml: toCatalogInfoYaml(buildBrunoEntity(input))
    });
  }, []);

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
        open={flow.status === 'form' || flow.status === 'adding'}
        initialPartOf={initialPartOf}
        adding={flow.status === 'adding'}
        error={flow.status === 'form' ? flow.error : undefined}
        onClose={() => setFlow({ status: 'closed' })}
        // Withheld rather than passed-and-ignored when this instance does not
        // store collections: the dialog renders its second ending only if it
        // has somewhere to send it, so one condition decides both the button
        // and the copy that describes it.
        // Two conditions, one withholding. `allowRuntimeWrites` is the
        // operator's decision for the whole instance and `bruno.collection.create`
        // is the policy's for this user; either one refusing means the backend
        // would answer 403, so the dialog is not offered the ending at all.
        onAdd={runtimeAvailable && mayCreate ? onAdd : undefined}
        onCreatePullRequest={onCreatePullRequest}
      />

      {flow.status === 'descriptor' && (
        <GeneratedYamlDialog
          open
          collectionUrl={flow.input.url}
          name={flow.input.name}
          title={flow.input.title}
          yaml={flow.yaml}
          catalogImportPath={catalogImportPath}
          onClose={() => setFlow({ status: 'closed' })}
        />
      )}
    </>
  );
}
