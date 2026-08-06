import { InfoCard } from '@backstage/core-components';
import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import type { DashboardStats } from '../../api/types';

/** Three summary tiles: Collections / Total Requests / Linked Entities. */
export function StatTiles(props: { stats: DashboardStats }): JSX.Element {
  const { stats } = props;
  const tiles: Array<{ label: string; value: number }> = [
    { label: 'Collections', value: stats.collections },
    { label: 'Total Requests', value: stats.totalRequests },
    { label: 'Linked Entities', value: stats.linkedEntities }
  ];

  return (
    <Grid container spacing={2}>
      {tiles.map((tile) => (
        <Grid item xs={12} sm={4} key={tile.label}>
          <InfoCard>
            <Typography variant="caption" color="textSecondary">
              {tile.label}
            </Typography>
            <Typography variant="h4">{tile.value}</Typography>
          </InfoCard>
        </Grid>
      ))}
    </Grid>
  );
}
