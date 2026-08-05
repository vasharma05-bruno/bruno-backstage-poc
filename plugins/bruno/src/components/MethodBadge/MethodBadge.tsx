import Chip from '@material-ui/core/Chip';
import { makeStyles } from '@material-ui/core/styles';

const COLORS: Record<string, string> = {
  GET: '#2e7d32', // green
  POST: '#1565c0', // blue
  PUT: '#e65100', // orange
  PATCH: '#6a1b9a', // purple
  DELETE: '#c62828', // red
  HEAD: '#455a64',
  OPTIONS: '#455a64'
};

const useStyles = makeStyles({
  chip: {
    color: '#fff',
    fontWeight: 700,
    fontFamily: 'monospace',
    height: 20,
    minWidth: 54,
    fontSize: 11,
    letterSpacing: 0.5,
    margin: 0
  }
});

/** Color-coded HTTP method badge (GET/POST/PUT/DELETE/...). */
export function MethodBadge(props: { method: string }) {
  const classes = useStyles();
  const method = (props.method || 'GET').toUpperCase();
  const bg = COLORS[method] ?? '#455a64';
  return (
    <Chip
      className={classes.chip}
      label={method}
      style={{ backgroundColor: bg }}
      size="small"
    />
  );
}
