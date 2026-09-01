import { useEffect, useState } from 'react';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import CircularProgress from '@material-ui/core/CircularProgress';
import Dialog from '@material-ui/core/Dialog';
import DialogActions from '@material-ui/core/DialogActions';
import DialogContent from '@material-ui/core/DialogContent';
import DialogTitle from '@material-ui/core/DialogTitle';
import InputAdornment from '@material-ui/core/InputAdornment';
import TextField from '@material-ui/core/TextField';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import { useApi } from '@backstage/core-plugin-api';
import { stringifyEntityRef } from '@backstage/catalog-model';
import type { Entity } from '@backstage/catalog-model';
import {
  CatalogAutocomplete,
  catalogApiRef,
  humanizeEntityRef
} from '@backstage/plugin-catalog-react';
import { brunoApiRef } from '../../api';
import type { ProbeFound } from '../../api';
import { validateScmRepoUrl } from '../../lib/scmProviders';
import { useBrandStyles } from '../../theme/brandStyles';
import type { BrunoEntityInput } from './generateCatalogInfo';
import { sanitizeEntityName, validateEntityName } from './generateCatalogInfo';

const useStyles = makeStyles((theme) => ({
  field: {
    marginTop: theme.spacing(2)
  },
  hint: {
    marginTop: theme.spacing(0.5)
  },
  found: {
    color: theme.palette.success.main
  }
}));

/**
 * How long the URL field sits still before the backend is asked about it.
 *
 * A probe is a `readTree` of a whole repository on a cache miss, so it is far
 * too expensive to fire per keystroke — and a pasted URL (the overwhelmingly
 * common case) arrives in one event anyway, so the delay is paid once.
 */
const PROBE_DEBOUNCE_MS = 600;

/** What we currently know about the URL in the field. */
type Probe
  = | { status: 'empty' }
    | { status: 'invalid'; message: string }
    | { status: 'probing' }
    | { status: 'found'; manifest: ProbeFound }
    | { status: 'no-manifest' }
    | { status: 'unreadable'; message: string };

/** The catalog fetch backing one of the two pickers. */
type Options
  = | { status: 'loading' }
    | { status: 'ready'; entities: Entity[] }
    | { status: 'error'; message: string };

/**
 * The `fields` projection both pickers use.
 *
 * Enough to label an option and to build its entity reference, and nothing else
 * — an unprojected `getEntities` over every API and Group in a real instance
 * pulls their specs, their relations and their OpenAPI definitions across the
 * wire to render a dropdown of names.
 */
const PICKER_FIELDS = [
  'kind',
  'metadata.name',
  'metadata.namespace',
  'metadata.title'
];

/** The label an option shows, preferring the human title the catalog carries. */
function optionLabel(entity: Entity, defaultKind: string): string {
  return entity.metadata.title ?? humanizeEntityRef(entity, { defaultKind });
}

/**
 * Last path segment of a URL, as a fallback collection name.
 *
 * A manifest is allowed to omit its name, and an unnamed collection still needs
 * a `metadata.name`. The folder the collection lives in is the best guess
 * available and is usually what the operator would have typed anyway.
 */
function nameFromUrl(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? '';
  } catch {
    return '';
  }
}

/**
 * Modal 1 of the add-collection flow: describe the collection.
 *
 * The URL field is the gate. Nothing else in the dialog is worth filling in
 * until the backend has confirmed there is a Bruno manifest at that URL, because
 * a descriptor pointing at a repository with no `bruno.json` or
 * `opencollection.yml` produces an entity that lands in the catalog and then
 * stays permanently degraded — `BrunoKindProcessor` logs the missing manifest
 * and ingests it anyway rather than rejecting it, precisely so that a repo which
 * goes temporarily unreadable does not vanish from the catalog. That leniency is
 * right for an existing entity and wrong for a new one, so the check happens
 * here instead.
 *
 * Submitting CREATES the collection. It still is not the catalog that creates
 * it: the catalog has no "create entity" endpoint — entities come from a
 * Location that must already exist or from an EntityProvider — so the fields go
 * to the Bruno backend's own store and `BrunoCollectionEntityProvider`
 * materialises the entity from there on its next tick. That indirection is the
 * reason the collection appears within `bruno.schedule.frequencySeconds` rather
 * than instantly, and modal 2 is where that wait is explained.
 */
export function AddCollectionDialog(props: {
  open: boolean;
  onClose: () => void;
  /**
   * An API entity reference to preselect, from `?partOf=` on the dashboard URL.
   * This is how the "Add a new Bruno Collection" button on an API page carries
   * its API across the navigation.
   */
  initialPartOf?: string;
  /**
   * Creates the collection, resolving `true` when it was created.
   *
   * The boolean is what decides whether the form empties itself — see
   * {@link reset}. It is a promise because the create is a round trip the user
   * has to be held through; the dialog stays open and inert for its duration
   * rather than closing optimistically.
   */
  onSubmit: (input: BrunoEntityInput) => Promise<boolean>;
  /** Whether a create is in flight, which locks the dialog's actions. */
  submitting?: boolean;
  /** The last create failure, shown under the actions. */
  error?: string;
}): JSX.Element {
  const {
    open,
    onClose,
    initialPartOf,
    onSubmit,
    submitting = false,
    error
  } = props;
  const classes = useStyles();
  const brandClasses = useBrandStyles();
  const brunoApi = useApi(brunoApiRef);
  const catalogApi = useApi(catalogApiRef);

  const [url, setUrl] = useState('');
  const [probe, setProbe] = useState<Probe>({ status: 'empty' });
  const [name, setName] = useState('');
  /**
   * Whether the user has edited the name themselves.
   *
   * Without it, prefilling from the probe would silently overwrite a name the
   * user had already typed every time they went back and adjusted the URL.
   */
  const [nameEdited, setNameEdited] = useState(false);
  const [apis, setApis] = useState<Options>({ status: 'loading' });
  const [selectedApis, setSelectedApis] = useState<Entity[]>([]);
  const [groups, setGroups] = useState<Options>({ status: 'loading' });
  const [owner, setOwner] = useState<Entity | null>(null);

  /**
   * Probes the URL once it has stopped changing.
   *
   * Both the timer and the in-flight request are cancelled by the same
   * `cancelled` flag, so a fast typist cannot have an early probe resolve after
   * a later one and overwrite the newer answer with a stale one.
   */
  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed) {
      setProbe({ status: 'empty' });
      return undefined;
    }
    const clientError = validateScmRepoUrl(trimmed);
    if (clientError) {
      setProbe({ status: 'invalid', message: clientError });
      return undefined;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setProbe({ status: 'probing' });
      brunoApi
        .probeCollection(trimmed)
        .then((result) => {
          if (cancelled) {
            return;
          }
          if (result.found) {
            setProbe({ status: 'found', manifest: result });
          } else if (result.reason === 'no-manifest') {
            setProbe({ status: 'no-manifest' });
          } else {
            setProbe({ status: 'unreadable', message: result.message });
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setProbe({
              status: 'unreadable',
              message: e instanceof Error ? e.message : String(e)
            });
          }
        });
    }, PROBE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [brunoApi, url]);

  /**
   * Prefills the name from the manifest, until the user takes it over.
   *
   * Runs off the probe rather than inside its `then` so that going back to an
   * already-probed URL refills the field the same way the first probe did.
   */
  useEffect(() => {
    if (nameEdited || probe.status !== 'found') {
      return;
    }
    const raw = probe.manifest.name ?? nameFromUrl(url.trim());
    setName(raw ? sanitizeEntityName(raw) : '');
  }, [nameEdited, probe, url]);

  /** Loads both pickers' options, once per opening. */
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    let cancelled = false;
    const load = (
      kind: string,
      set: (options: Options) => void
    ): void => {
      set({ status: 'loading' });
      catalogApi
        .getEntities({ filter: { kind }, fields: PICKER_FIELDS })
        .then((res) => {
          if (!cancelled) {
            set({ status: 'ready', entities: res.items });
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            set({
              status: 'error',
              message: e instanceof Error ? e.message : String(e)
            });
          }
        });
    };
    load('API', setApis);
    load('Group', setGroups);
    return () => {
      cancelled = true;
    };
  }, [catalogApi, open]);

  /**
   * Applies `?partOf=` once the API options have arrived.
   *
   * Matching on the STRINGIFIED ref rather than on object identity is what makes
   * the deep link work at all: the ref in the query string is a string, and the
   * autocomplete's value has to be one of the option objects for MUI to show it
   * as selected.
   */
  useEffect(() => {
    if (!open || !initialPartOf || apis.status !== 'ready') {
      return;
    }
    const match = apis.entities.find(
      (e) => stringifyEntityRef(e) === initialPartOf
    );
    if (match) {
      setSelectedApis((current) =>
        current.length === 0 ? [match] : current);
    }
  }, [apis, initialPartOf, open]);

  /**
   * Empties the form.
   *
   * Called on cancel, and on a submit that SUCCEEDED. The dialog stays MOUNTED
   * once the flow hands off to modal 2 (it is only `open={false}`), so without
   * this the next press of "Add Bruno Collection" would open a form already
   * filled in with the collection the user just finished registering.
   */
  const reset = (): void => {
    setUrl('');
    setProbe({ status: 'empty' });
    setName('');
    setNameEdited(false);
    setSelectedApis([]);
    setOwner(null);
  };

  const close = (): void => {
    reset();
    onClose();
  };

  const nameError = name ? validateEntityName(name) : undefined;
  const canSubmit = probe.status === 'found' && !!name && !nameError;

  /**
   * Submits, and clears the form ONLY if the collection was created.
   *
   * `reset()` used to sit on the unconditional path here, which was correct
   * while submitting could not fail. Now it can, and the failure that dominates
   * is a name already taken — a `409` the user answers by changing one field.
   * Emptying the form on that would throw away a URL that had to be probed, an
   * API selection and an owner, to punish a typo in the one field that was
   * wrong. The awaited boolean is the minimal signal that distinguishes the two
   * cases; it needs no extra state.
   */
  const submit = async (): Promise<void> => {
    if (!canSubmit) {
      return;
    }
    const created = await onSubmit({
      name,
      url: url.trim(),
      partOf: selectedApis.map((e) => stringifyEntityRef(e)),
      owner: owner ? stringifyEntityRef(owner) : undefined
    });
    if (created) {
      reset();
    }
  };

  /** The one-line verdict under the URL field. */
  let urlHelper: JSX.Element | null = null;
  switch (probe.status) {
    case 'invalid':
      urlHelper = (
        <Typography variant="body2" color="error" className={classes.hint}>
          {probe.message}
        </Typography>
      );
      break;
    case 'probing':
      urlHelper = (
        <Typography
          variant="body2"
          color="textSecondary"
          className={classes.hint}
        >
          Looking for a Bruno collection at this URL…
        </Typography>
      );
      break;
    case 'found':
      urlHelper = (
        <Typography
          variant="body2"
          className={`${classes.hint} ${classes.found}`}
        >
          Found <code>{probe.manifest.manifestPath}</code>
          {probe.manifest.version ? ` (version ${probe.manifest.version})` : ''}
          .
        </Typography>
      );
      break;
    case 'no-manifest':
      urlHelper = (
        <Typography variant="body2" color="error" className={classes.hint}>
          No <code>bruno.json</code> or <code>opencollection.yaml</code> found at
          this URL. Point at the folder that holds the collection, not at the
          repository root, if the collection lives in a subdirectory.
        </Typography>
      );
      break;
    case 'unreadable':
      urlHelper = (
        <Typography variant="body2" color="error" className={classes.hint}>
          Backstage could not read this URL: {probe.message}
        </Typography>
      );
      break;
    default:
      urlHelper = null;
  }

  return (
    <Dialog
      open={open}
      maxWidth="md"
      fullWidth
      // Dismissing mid-create would empty the form (`close` resets) while the
      // create it started is still running, so the user would lose the fields
      // and then be handed modal 2 for a collection they can no longer see the
      // inputs of. Same reasoning as modal 2's guard around the pull request.
      disableBackdropClick={submitting}
      disableEscapeKeyDown={submitting}
      onClose={close}
    >
      <DialogTitle>Add a Bruno collection</DialogTitle>
      <DialogContent>
        <Typography variant="body2">
          Point Backstage at a collection in source control. Submitting
          registers it in the catalog. The next step shows the equivalent{' '}
          <code>catalog-info.yaml</code>, which you can download or open as a
          pull request if you also want the descriptor in your repository — both
          are optional.
        </Typography>

        <Box className={classes.field}>
          <TextField
            fullWidth
            variant="outlined"
            label="Collection URL"
            placeholder="https://github.com/owner/repo/tree/main/collection"
            value={url}
            error={
              probe.status === 'invalid'
              || probe.status === 'no-manifest'
              || probe.status === 'unreadable'
            }
            onChange={(event) => setUrl(event.target.value)}
            InputProps={{
              endAdornment:
                probe.status === 'probing'
                  ? (
                      <InputAdornment position="end">
                        <CircularProgress size={16} />
                      </InputAdornment>
                    )
                  : probe.status === 'found'
                    ? (
                        <InputAdornment position="end">
                          <CheckCircleIcon
                            fontSize="small"
                            className={classes.found}
                          />
                        </InputAdornment>
                      )
                    : undefined
            }}
          />
          {urlHelper}
        </Box>

        <Box className={classes.field}>
          <TextField
            fullWidth
            variant="outlined"
            label="Entity name"
            value={name}
            error={!!nameError}
            helperText={nameError}
            disabled={probe.status !== 'found'}
            onChange={(event) => {
              setNameEdited(true);
              setName(event.target.value);
            }}
          />
          <Typography
            variant="body2"
            color="textSecondary"
            className={classes.hint}
          >
            Required, and permanent. The catalog freezes an entity&apos;s
            reference before any processor runs, so this cannot be derived from
            the collection later — renaming it means registering a new entity.
          </Typography>
        </Box>

        <Box className={classes.field}>
          <CatalogAutocomplete<Entity, true>
            multiple
            name="related-apis"
            label="Related APIs"
            options={apis.status === 'ready' ? apis.entities : []}
            value={selectedApis}
            loading={apis.status === 'loading'}
            getOptionLabel={(option) => optionLabel(option, 'API')}
            getOptionSelected={(option, value) =>
              stringifyEntityRef(option) === stringifyEntityRef(value)}
            onChange={(_event, value) => setSelectedApis([...value])}
            TextFieldProps={{ placeholder: 'Search API entities' }}
          />
          <Typography
            variant="body2"
            color="textSecondary"
            className={classes.hint}
          >
            {apis.status === 'error'
              ? `Could not load API entities: ${apis.message}`
              : 'Each one becomes an entry in spec.partOf. The reverse relation '
                + 'on the API entity is derived from it.'}
          </Typography>
        </Box>

        <Box className={classes.field}>
          <CatalogAutocomplete<Entity>
            name="owner"
            label="Owner (optional)"
            options={groups.status === 'ready' ? groups.entities : []}
            value={owner}
            loading={groups.status === 'loading'}
            getOptionLabel={(option) => optionLabel(option, 'Group')}
            getOptionSelected={(option, value) =>
              stringifyEntityRef(option) === stringifyEntityRef(value)}
            onChange={(_event, value) => setOwner(value ?? null)}
            TextFieldProps={{ placeholder: 'Search groups' }}
          />
        </Box>

        {/*
          The create failure sits with the form rather than replacing it: the
          message is almost always about one field ("a collection named X was
          already added"), and it is only actionable while the rest of the
          answers are still on screen.
        */}
        {error && (
          <Typography
            variant="body2"
            color="error"
            className={classes.field}
          >
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          className={brandClasses.accentButton}
          disabled={!canSubmit || submitting}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
          onClick={() => void submit()}
        >
          {submitting ? 'Adding…' : 'Add collection'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
