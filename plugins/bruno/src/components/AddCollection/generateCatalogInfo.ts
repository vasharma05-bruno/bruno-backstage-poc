import { stringify } from 'yaml';
import type { Entity } from '@backstage/catalog-model';
import { BRUNO_ORIGIN_ANNOTATION } from '../../lib/brunoEntity';
import { tryNormaliseApiRef } from '../../lib/apiRef';

/**
 * Builds the `catalog-info.yaml` the add-collection flow hands to the user.
 *
 * Pure, and separate from the dialogs, because the SAME text has to reach three
 * places byte-for-byte identically: the preview on screen, the file the Download
 * button writes, and the `fileContent` of the pull request. Any one of those
 * re-serialising the entity for itself would eventually drift, and the user
 * would download a file that is not the one they reviewed.
 *
 * Mirrors `brunoEntityV1alpha1Schema` in
 * plugins/bruno-backend/src/processor/BrunoKindProcessor.ts — keep the two in
 * step.
 */

/**
 * The apiVersion the `Bruno` kind is written against.
 *
 * Duplicated from the backend's `BRUNO_API_VERSION` rather than imported: the
 * frontend plugin does not depend on the backend package, and a wrong value here
 * fails loudly and immediately (the catalog rejects the entity as unrecognised),
 * so the duplication cannot rot silently.
 */
const BRUNO_API_VERSION = 'usebruno.com/v1alpha1';

/** The only `spec.type` this flow produces. */
const BRUNO_COLLECTION_TYPE = 'bruno-collection';

/**
 * `metadata.name`'s grammar, from `@backstage/catalog-model`'s entity envelope
 * schema: alphanumerics, dashes, underscores and dots, starting and ending
 * alphanumeric, at most 63 characters.
 */
const ENTITY_NAME_PATTERN = /^[a-zA-Z0-9]([-_.a-zA-Z0-9]*[a-zA-Z0-9])?$/;
const MAX_ENTITY_NAME_LENGTH = 63;

/** Everything the flow collects before it can write a descriptor. */
export interface BrunoEntityInput {
  /** `metadata.name`. Required — see {@link buildBrunoEntity}. */
  name: string;
  /** `spec.url` — the collection folder in source control. */
  url: string;
  /** Entity references for `spec.partOf`. */
  partOf: string[];
  /** `spec.owner`, when one was picked. */
  owner?: string;
}

/**
 * Turns a manifest's collection name into something the catalog will accept as
 * `metadata.name`, or falls back to a generic one.
 *
 * Lossy on purpose: `My Collection (v2)` becomes `my-collection-v2`, and the
 * original survives on the entity anyway — `BrunoKindProcessor` copies the
 * manifest name into `metadata.title`, which is what every card actually
 * displays. The name only has to be a stable, legal identifier.
 */
export function sanitizeEntityName(raw: string): string {
  const slug = raw
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9._-]+/g, '-')
    // Leading/trailing separators are legal mid-name but not at the ends.
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, MAX_ENTITY_NAME_LENGTH)
    .replace(/[-_.]+$/g, '');
  return slug || 'bruno-collection';
}

/**
 * Validates a `metadata.name` the user typed, returning an error string or
 * `undefined`.
 *
 * Checked HERE rather than left to the catalog because the catalog's rejection
 * arrives at the far end of a pull request: `catalogImportApi.submitPullRequest`
 * validates before it commits, so a bad name surfaces as an opaque schema error
 * after the user has already reviewed and clicked. Worse, the name cannot be
 * fixed later by a processor — the catalog freezes an entity's ref before any
 * processor runs and throws a `ConflictError` if one changes it — so it is the
 * one field that has to be right at authoring time.
 */
export function validateEntityName(name: string): string | undefined {
  if (!name) {
    return 'A name is required.';
  }
  if (name.length > MAX_ENTITY_NAME_LENGTH) {
    return `Names are at most ${MAX_ENTITY_NAME_LENGTH} characters.`;
  }
  if (!ENTITY_NAME_PATTERN.test(name)) {
    return 'Use letters, digits, dashes, underscores and dots; start and end '
      + 'with a letter or digit.';
  }
  return undefined;
}

/**
 * The `kind: Bruno` entity for a collection the user just described.
 *
 * Note what is deliberately NOT written, even though the probe gives us all
 * three: `metadata.title`, `metadata.description` and `metadata.version`.
 * `BrunoKindProcessor` treats AUTHORED values for those as winning over the
 * fetched manifest, so stamping today's manifest values into the descriptor
 * would freeze them forever — rename the collection in `bruno.json` and
 * Backstage would keep showing the old name, with no way to tell why. Leaving
 * them out is what keeps them live.
 *
 * `spec.definition`, `spec.requestCount` and `spec.environments` are likewise
 * absent: the processor owns them outright and overwrites any authored value.
 */
export function buildBrunoEntity(input: BrunoEntityInput): Entity {
  const partOf = input.partOf
    .map(tryNormaliseApiRef)
    .filter((ref): ref is string => ref !== undefined);

  return {
    apiVersion: BRUNO_API_VERSION,
    kind: 'Bruno',
    metadata: {
      name: input.name,
      annotations: {
        // Records that THIS plugin generated the descriptor, which nothing else
        // can tell afterwards: a `catalog-info.yaml` we wrote is byte-for-byte
        // indistinguishable from a hand-written one, so without the stamp the
        // UI cannot say "added in Backstage" or tailor its editing advice. The
        // processor preserves an origin that is already present rather than
        // overwriting it (`deriveOrigin`), which is exactly why writing it into
        // the file works: the value survives every reprocess cycle.
        [BRUNO_ORIGIN_ANNOTATION]: 'ui'
      }
    },
    spec: {
      type: BRUNO_COLLECTION_TYPE,
      url: input.url,
      ...(input.owner ? { owner: input.owner } : {}),
      ...(partOf.length > 0 ? { partOf } : {})
    }
  };
}

/**
 * The descriptor as a file, with a header explaining where it came from.
 *
 * The header is for the reviewer of the pull request, not for Backstage: they
 * see a YAML file appear at their repository root and have to decide whether to
 * merge it. `lineWidth: 0` disables `yaml`'s line folding, which would otherwise
 * wrap a long collection URL across two lines — legal YAML, but it reads like a
 * mistake in a diff.
 */
export function toCatalogInfoYaml(entity: Entity): string {
  const header = [
    '# Backstage catalog entity for a Bruno collection.',
    '#',
    '# Generated by the Bruno plugin for Backstage. Edit it freely — the',
    '# plugin never rewrites this file; it only opens pull requests against it.',
    '#',
    '# `metadata.title`, `metadata.description` and `metadata.version` are',
    '# deliberately omitted so they stay in sync with the collection manifest.',
    '# Set one here and it wins over the manifest from then on.',
    ''
  ].join('\n');
  return `${header}\n${stringify(entity, { lineWidth: 0 })}`;
}
