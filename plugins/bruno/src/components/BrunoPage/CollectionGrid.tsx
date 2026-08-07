import Grid from '@material-ui/core/Grid';
import { CollectionCard } from './CollectionCard';
import type { DashboardCollection } from '../../api/types';

/** Two-column grid of collection cards. */
export function CollectionGrid(props: {
  collections: DashboardCollection[];
  onRequestLink?: (collectionId: string) => void;
  onChanged?: () => void;
}): JSX.Element {
  const { collections, onRequestLink, onChanged } = props;
  return (
    <Grid container spacing={2}>
      {collections.map((collection) => (
        <Grid item xs={12} md={6} key={collection.id}>
          <CollectionCard
            collection={collection}
            onRequestLink={onRequestLink}
            onChanged={onChanged}
          />
        </Grid>
      ))}
    </Grid>
  );
}
