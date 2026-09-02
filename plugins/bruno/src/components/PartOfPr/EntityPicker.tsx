import { useEffect, useState } from 'react';
import Typography from '@material-ui/core/Typography';
import { Progress } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { stringifyEntityRef } from '@backstage/catalog-model';
import type { Entity } from '@backstage/catalog-model';
import { CatalogAutocomplete, catalogApiRef } from '@backstage/plugin-catalog-react';

/** The catalog fetch behind a picker. */
export type EntityOptions
  = | { status: 'loading' }
    | { status: 'ready'; entities: Entity[] }
    | { status: 'error'; message: string };

/**
 * Loads every entity of one kind, once per opening of a dialog.
 *
 * All fields, no `fields` projection: the pickers need the title, the version,
 * the source URL and `backstage.io/managed-by-location` (to work out whether a
 * pull request is even possible), which is most of the entity anyway — and both
 * collections and APIs number in the tens, not the thousands.
 */
export function useEntityOptions(kind: string, open: boolean): EntityOptions {
  const catalogApi = useApi(catalogApiRef);
  const [options, setOptions] = useState<EntityOptions>({ status: 'loading' });

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    let cancelled = false;
    setOptions({ status: 'loading' });
    catalogApi
      .getEntities({ filter: { kind } })
      .then((res) => {
        if (!cancelled) {
          setOptions({ status: 'ready', entities: res.items });
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setOptions({
            status: 'error',
            message: e instanceof Error ? e.message : String(e)
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalogApi, kind, open]);

  return options;
}

/**
 * How many entities the caller is picking. One flow wants exactly one and the
 * other wants a set, and the two have different `value`/`onChange` types — a
 * discriminated union keeps a caller from mixing them up.
 */
type Selection
  = | {
    multiple?: false;
    value: Entity | null;
    onChange: (entity: Entity | null) => void;
  }
  | {
    multiple: true;
    value: Entity[];
    onChange: (entities: Entity[]) => void;
  };

/**
 * The "which entity" step both link flows open with: an autocomplete over one
 * kind, minus what is already linked.
 *
 * The three non-picker states are the point of the component. "Still loading",
 * "the catalog call failed", "there is nothing to pick" and "everything is
 * already linked" read identically as an inert empty box, and each needs its
 * own sentence.
 */
export function EntityPicker(props: {
  options: EntityOptions;
  /** Refs already linked, hidden from the list. */
  excluded: string[];
  disabled?: boolean;
  name: string;
  label: string;
  placeholder: string;
  /** Said when the catalog holds none of this kind at all. */
  emptyNone: string;
  /** Said when it holds some, but all of them are already linked. */
  emptyAll: string;
  /** Leads the message when the catalog call itself failed. */
  errorTitle: string;
} & Selection): JSX.Element {
  const {
    options,
    excluded,
    disabled,
    name,
    label,
    placeholder,
    emptyNone,
    emptyAll,
    errorTitle
  } = props;

  if (options.status === 'loading') {
    return <Progress />;
  }
  if (options.status === 'error') {
    return (
      <Typography variant="body2" color="error">
        {errorTitle}: {options.message}
      </Typography>
    );
  }

  const linked = new Set(excluded);
  const available = options.entities.filter(
    (e) => !linked.has(stringifyEntityRef(e))
  );
  if (available.length === 0) {
    return (
      <Typography variant="body2" color="textSecondary">
        {options.entities.length === 0 ? emptyNone : emptyAll}
      </Typography>
    );
  }

  const common = {
    name,
    label,
    disabled,
    options: available,
    getOptionLabel: (option: Entity) =>
      option.metadata.title ?? option.metadata.name,
    // Entities are compared by reference otherwise, and the catalog hands back
    // a fresh object on every fetch.
    getOptionSelected: (option: Entity, value: Entity) =>
      stringifyEntityRef(option) === stringifyEntityRef(value),
    TextFieldProps: { placeholder }
  };

  return props.multiple
    ? (
        <CatalogAutocomplete<Entity, true>
          {...common}
          multiple
          // Picking a second API should not mean reopening the list.
          disableCloseOnSelect
          value={props.value}
          onChange={(_event, entities) => props.onChange(entities)}
        />
      )
    : (
        <CatalogAutocomplete<Entity>
          {...common}
          value={props.value}
          onChange={(_event, entity) => props.onChange(entity ?? null)}
        />
      );
}
