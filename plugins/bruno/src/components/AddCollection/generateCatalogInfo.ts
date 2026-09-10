import { stringify } from 'yaml';
import type { Entity } from '@backstage/catalog-model';
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

/**
 * `metadata.title`'s length cap.
 *
 * Not a platform limit — the entity envelope schema puts no bound on `title` at
 * all. It mirrors `MAX_LABEL_LENGTH` in
 * plugins/bruno-backend/src/service/manifestProbe.ts, which is what the backend
 * clamps a manifest's own name to before it ever reaches an entity. Allowing a
 * longer authored title than a fetched one could produce would mean the field's
 * default (the manifest name) and the field's limit disagreed.
 */
const MAX_TITLE_LENGTH = 255;

/** Everything the flow collects before it can write a descriptor. */
export interface BrunoEntityInput {
  /** `metadata.name`. Required — see {@link buildBrunoEntity}. */
  name: string;
  /**
   * `metadata.title` — the human name every card and header actually shows.
   *
   * Optional, and the emptiness is meaningful rather than sloppy: an absent
   * title is what hands the field back to `BrunoKindProcessor`, which fills it
   * from the collection manifest on every processing cycle. See
   * {@link buildBrunoEntity} for what authoring one gives up.
   */
  title?: string;
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
 * Validates a `metadata.title` the user typed, returning an error string or
 * `undefined`.
 *
 * Far weaker than {@link validateEntityName}, and deliberately: `title` is free
 * prose in the entity envelope, it is not part of the entity reference, and —
 * unlike the name — it can be changed later by editing one line of the
 * descriptor. Length is the only thing worth checking, and only because a title
 * long enough to break the layout of every card is easier to catch here than to
 * notice on the dashboard afterwards.
 *
 * An EMPTY title is not an error. It is the opt-out: see
 * {@link buildBrunoEntity}.
 */
export function validateEntityTitle(title: string): string | undefined {
  if (title.length > MAX_TITLE_LENGTH) {
    return `Titles are at most ${MAX_TITLE_LENGTH} characters.`;
  }
  return undefined;
}

/**
 * The `kind: Bruno` entity for a collection the user just described.
 *
 * `metadata.title` is written when the form supplied one, and what that COSTS
 * has to be stated plainly, because it is the reason this used to be omitted.
 * `BrunoKindProcessor` resolves the field as `keep(authored) ?? manifest.name`,
 * so an authored title wins over the manifest from then on: rename the
 * collection in `bruno.json` and Backstage keeps showing the title in this file
 * until somebody edits it. That is now the intended trade — a descriptor is a
 * file people are meant to edit, the pull request puts the value in front of a
 * reviewer, and a catalog entity whose display name cannot be chosen is a worse
 * answer than one whose display name has to be maintained. The dialog seeds the
 * field FROM the manifest name, so the common case is a descriptor that agrees
 * with the collection on the day it is opened.
 *
 * Clearing the field is the way back: with no `title` key the processor fills it
 * from the manifest on every cycle, exactly as it did before this flow could
 * write one.
 *
 * `metadata.description` and `metadata.version` are still deliberately NOT
 * written, even though the probe gives us both, and for the reason the title
 * used to be omitted too — nobody asked to choose those, so freezing them buys
 * nothing and costs a value that would otherwise track the collection.
 *
 * `spec.definition`, `spec.requestCount` and `spec.environments` are likewise
 * absent: the processor owns them outright and overwrites any authored value.
 *
 * NO `usebruno.com/origin` either, and that omission is load-bearing. The
 * descriptor path registers nothing in the Bruno backend's store — it produces a
 * file and a pull request, and the entity exists only once that file is
 * registered as a catalog location. So the collection this describes is
 * `descriptor`-origin, which is exactly what `deriveOrigin` defaults to for a
 * `url` location, and stamping it here would only be a second, hand-written copy
 * of a value the processor computes correctly.
 *
 * Stamping `ui` — which this did while submitting the form registered the
 * collection — is now actively wrong: `usebruno.com/origin: ui` is what the
 * dashboard gates its Remove action on (`BrunoPage.tsx`), and Remove calls
 * `DELETE /collections/:name` against a store row that this path never wrote.
 * The user would be offered a delete button that answers 404.
 */
export function buildBrunoEntity(input: BrunoEntityInput): Entity {
  const partOf = input.partOf
    .map(tryNormaliseApiRef)
    .filter((ref): ref is string => ref !== undefined);

  // Trimmed, and dropped entirely when nothing is left. A `title: ''` key would
  // be the worst of both: authored enough to survive into the file, and empty
  // enough that `keep` treats it as absent — so the descriptor would carry a
  // field the catalog ignores, and a reader diffing the file against the
  // dashboard would have no way to explain the difference.
  const title = input.title?.trim();

  return {
    apiVersion: BRUNO_API_VERSION,
    kind: 'Bruno',
    metadata: {
      name: input.name,
      ...(title ? { title } : {})
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
 *
 * The note about the omitted fields BRANCHES on whether a title was authored,
 * rather than describing both cases in one paragraph. The reviewer is being
 * asked what this file does, and the answer genuinely differs: with a `title:`
 * key the file is the display name's source of truth and the manifest no longer
 * is, and a header that hedged about a key which may or may not be a few lines
 * below would leave them to work out which file they are reading.
 */
export function toCatalogInfoYaml(entity: Entity): string {
  const header = [
    '# Backstage catalog entity for a Bruno collection.',
    '#',
    '# Generated by the Bruno plugin for Backstage. Edit it freely — the',
    '# plugin never rewrites this file; it only opens pull requests against it.',
    '#',
    // Each branch is a WHOLE paragraph rather than two openings sharing a
    // tail: the shared version saved two lines and cost a ragged one-clause
    // line in the middle of a comment block a reviewer is meant to read.
    ...(entity.metadata.title
      ? [
          '# `metadata.title` below is what Backstage displays for this',
          '# collection, and it WINS over the name in the collection manifest',
          '# from now on. Delete the line to go back to following the manifest.',
          '#',
          '# `metadata.description` and `metadata.version` are deliberately',
          '# omitted so they stay in sync with the manifest. Set either here',
          '# and it wins the same way.'
        ]
      : [
          '# `metadata.title`, `metadata.description` and `metadata.version` are',
          '# deliberately omitted so they stay in sync with the collection',
          '# manifest. Set one here and it wins over the manifest from then on.'
        ]),
    ''
  ].join('\n');
  return `${header}\n${stringify(entity, { lineWidth: 0 })}`;
}
