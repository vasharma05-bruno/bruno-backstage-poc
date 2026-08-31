import Grid from '@material-ui/core/Grid';
import Tooltip from '@material-ui/core/Tooltip';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import { useBrandStyles } from '../../theme/brandStyles';
import { BrunoInfoCard } from '../BrunoInfoCard';

const useStyles = makeStyles({
  label: {
    display: 'block',
    letterSpacing: 0.6,
    textTransform: 'uppercase'
  }
});

/** One headline figure on the dashboard. */
export interface StatTile {
  /** Uppercased caption above the figure. */
  label: string;
  /**
   * The figure itself. A string is rendered verbatim, which is how a
   * not-yet-known value shows an em dash instead of a misleading `0`.
   */
  value: number | string;
  /** Optional hover copy explaining how the figure is derived. */
  hint?: string;
}

/**
 * A row of headline figures across the top of the Bruno dashboard.
 *
 * Titleless Bruno cards, so each tile is a plain Material-UI card carrying just
 * the brand accent rule — the Bruno mark would be N-times redundant at this
 * size. The figures themselves take the brand accent.
 *
 * Generic over the tiles it is handed rather than over one fixed stats shape:
 * the numbers are derived in the page from the loaded catalog entities, and
 * which ones they are is the page's business, not this component's. Laid out as
 * thirds (`sm={4}`), which is what the dashboard's three PRD figures want.
 */
export function StatTiles(props: { tiles: StatTile[] }): JSX.Element {
  const { tiles } = props;
  const classes = useStyles();
  const brandClasses = useBrandStyles();

  return (
    <Grid container spacing={2}>
      {tiles.map((tile) => {
        const figure = (
          <Typography variant="h4" className={brandClasses.accentFigure}>
            {tile.value}
          </Typography>
        );
        return (
          <Grid item xs={12} sm={4} key={tile.label}>
            <BrunoInfoCard variant="fullHeight">
              <Typography
                variant="caption"
                color="textSecondary"
                className={classes.label}
              >
                {tile.label}
              </Typography>
              {tile.hint
                ? (
                    <Tooltip title={tile.hint} placement="bottom-start">
                      <span>{figure}</span>
                    </Tooltip>
                  )
                : (
                    figure
                  )}
            </BrunoInfoCard>
          </Grid>
        );
      })}
    </Grid>
  );
}
