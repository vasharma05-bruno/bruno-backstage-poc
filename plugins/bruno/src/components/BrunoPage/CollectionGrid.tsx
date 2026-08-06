import Grid from '@material-ui/core/Grid';
import { CollectionCard } from './CollectionCard';
import type { DashboardCollection } from '../../api/types';

/** Two-column grid of collection cards. */
export function CollectionGrid(props: {
  collections: DashboardCollection[];
  onRequestLink?: (collectionId: string) => void;
}): JSX.Element {
  const { collections, onRequestLink } = props;
  return (
    <Grid container spacing={2}>
      {collections.map((collection) => (
        <Grid item xs={12} md={6} key={collection.id}>
          <CollectionCard
            collection={collection}
            onRequestLink={onRequestLink}
          />
        </Grid>
      ))}
    </Grid>
  );
}
