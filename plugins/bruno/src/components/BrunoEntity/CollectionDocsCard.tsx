import { useMemo } from 'react';
import { parse } from 'yaml';
import { MarkdownContent } from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import { definition } from '../../lib/brunoEntity';
import { BrunoInfoCard } from '../BrunoInfoCard';

/**
 * Pulls the collection-level documentation out of an OpenCollection document.
 *
 * The generator puts the collection's root README at `root.docs` (see
 * `openCollectionExport.ts`), which is exactly what a "Documentation" card
 * should show. Parsing is wrapped because `spec.definition` is generated, not
 * authored — a malformed document is a backend bug, not something that should
 * take an Overview card down with it.
 */
function collectionDocs(yamlText: string | undefined): string | undefined {
  if (!yamlText) {
    return undefined;
  }
  try {
    const parsed = parse(yamlText) as { root?: { docs?: unknown } } | undefined;
    const docs = parsed?.root?.docs;
    return typeof docs === 'string' && docs.trim() ? docs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Overview card rendering the Bruno collection's own documentation.
 *
 * Reads it straight off the entity: `BrunoKindProcessor` stores the generated
 * OpenCollection YAML in `spec.definition`, and the collection README lands in
 * that document's `root.docs`. So there is no fetch, nothing to fail, and the
 * card is correct the moment the entity is.
 *
 * Falls back to `metadata.description` when the collection carries no README —
 * either because it has none, or because the definition has not been generated
 * yet (the processor writes it a cycle after the entity appears). Renders
 * nothing at all when both are empty: an empty card is worse than no card, the
 * same discipline the rest of the Bruno cards follow.
 */
export function CollectionDocsCard(): JSX.Element | null {
  const { entity } = useEntity();
  const docs = useMemo(
    () => collectionDocs(definition(entity)),
    [entity]
  );
  const content = docs ?? entity.metadata.description;

  if (!content) {
    return null;
  }

  return (
    <BrunoInfoCard title="Documentation">
      <MarkdownContent content={content} dialect="gfm" />
    </BrunoInfoCard>
  );
}
