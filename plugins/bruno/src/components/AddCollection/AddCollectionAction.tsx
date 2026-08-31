import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Button from '@material-ui/core/Button';
import AddIcon from '@material-ui/icons/Add';
import { useBrandStyles } from '../../theme/brandStyles';
import { AddCollectionDialog } from './AddCollectionDialog';
import { GeneratedYamlDialog } from './GeneratedYamlDialog';
import type { BrunoEntityInput } from './generateCatalogInfo';
import { buildBrunoEntity, toCatalogInfoYaml } from './generateCatalogInfo';

/** The query parameters that open this flow from elsewhere in the app. */
const OPEN_PARAM = 'add';
const PART_OF_PARAM = 'partOf';

/** What has been described so far, once modal 1 has been submitted. */
interface Generated {
  input: BrunoEntityInput;
  yaml: string;
}

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
 * The deep link is the other half of the contract. An API entity page's "Add a
 * new Bruno Collection" button cannot open a dialog that lives on another route,
 * so it navigates to `/bruno?add=1&partOf=<api ref>` and this reads those back.
 * The parameters are CONSUMED on open — stripped from the URL — so that a
 * browser reload, or a back-navigation after the flow finished, does not
 * silently reopen the dialog over the dashboard.
 */
export function AddCollectionAction(): JSX.Element {
  const brandClasses = useBrandStyles();
  const [searchParams, setSearchParams] = useSearchParams();

  const [open, setOpen] = useState(false);
  const [initialPartOf, setInitialPartOf] = useState<string | undefined>();
  const [generated, setGenerated] = useState<Generated | undefined>();

  useEffect(() => {
    if (!searchParams.has(OPEN_PARAM)) {
      return;
    }
    setInitialPartOf(searchParams.get(PART_OF_PARAM) ?? undefined);
    setOpen(true);

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

  const onSubmit = useCallback((input: BrunoEntityInput) => {
    // Serialised once, here, so the preview, the download and the pull request
    // all read the same string. See `generateCatalogInfo.ts`.
    setGenerated({ input, yaml: toCatalogInfoYaml(buildBrunoEntity(input)) });
    setOpen(false);
  }, []);

  return (
    <>
      <Button
        variant="contained"
        className={brandClasses.accentButton}
        startIcon={<AddIcon />}
        onClick={() => {
          setInitialPartOf(undefined);
          setOpen(true);
        }}
      >
        Add Bruno Collection
      </Button>

      <AddCollectionDialog
        open={open}
        initialPartOf={initialPartOf}
        onClose={() => setOpen(false)}
        onSubmit={onSubmit}
      />

      {generated && (
        <GeneratedYamlDialog
          open
          collectionUrl={generated.input.url}
          name={generated.input.name}
          yaml={generated.yaml}
          onClose={() => setGenerated(undefined)}
        />
      )}
    </>
  );
}
