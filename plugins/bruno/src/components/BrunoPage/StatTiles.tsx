import Grid from '@material-ui/core/Grid';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import { useBrandStyles } from '../../theme/brandStyles';
import { BrunoInfoCard } from '../BrunoInfoCard';
import type { DashboardStats } from '../../api/types';

const useStyles = makeStyles({
  label: {
    display: 'block',
    letterSpacing: 0.6,
    textTransform: 'uppercase'
  }
});

/**
 * Three summary tiles: Collections / Total Requests / Linked Entities.
 *
 * Titleless Bruno cards, so each tile is a plain Material-UI card carrying just
 * the brand accent rule — the Bruno mark would be three-times redundant at this
 * size. The figures themselves take the brand accent.
 */
export function StatTiles(props: { stats: DashboardStats }): JSX.Element {
  const { stats } = props;
  const classes = useStyles();
  const brandClasses = useBrandStyles();
  const tiles: Array<{ label: string; value: number }> = [
    { label: 'Collections', value: stats.collections },
    { label: 'Total Requests', value: stats.totalRequests },
    { label: 'Linked Entities', value: stats.linkedEntities }
  ];

  return (
    <Grid container spacing={2}>
      {tiles.map((tile) => (
        <Grid item xs={12} sm={4} key={tile.label}>
          <BrunoInfoCard variant="fullHeight">
            <Typography
              variant="caption"
              color="textSecondary"
              className={classes.label}
            >
              {tile.label}
            </Typography>
            <Typography variant="h4" className={brandClasses.accentFigure}>
              {tile.value}
            </Typography>
          </BrunoInfoCard>
        </Grid>
      ))}
    </Grid>
  );
}
