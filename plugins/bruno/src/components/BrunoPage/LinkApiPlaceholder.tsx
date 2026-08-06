import { EmptyState } from '@backstage/core-components';

/** Placeholder for the Link API tab; the real flow lands in N2-P5. */
export function LinkApiPlaceholder(): JSX.Element {
  return (
    <EmptyState
      missing="content"
      title="Link API — coming soon (N2-P5)"
      description="Linking a catalog API entity to a Bruno collection from this page is not available yet."
    />
  );
}
