import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import InfoOutlinedIcon from '@material-ui/icons/InfoOutlined';
import type { ReactNode } from 'react';

const useStyles = makeStyles((theme) => ({
  notice: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.spacing(1),
    padding: theme.spacing(0.75, 1),
    borderRadius: theme.shape.borderRadius,
    border: `1px solid ${theme.palette.divider}`,
    backgroundColor: theme.palette.background.default
  },
  icon: {
    fontSize: 18,
    // Optical alignment with the cap height of the first line, not the box.
    marginTop: 2,
    flex: '0 0 auto',
    color: theme.palette.text.secondary
  }
}));

/**
 * A standing statement of fact about the surface it sits on — most often "no
 * pull request is possible here, edit this by hand instead".
 *
 * An icon and a line of secondary text, deliberately NOT a `WarningPanel`: the
 * dialogs that use it are already mostly prose, and a titled callout for a
 * routine property of the selected collection read as an incident. It is also
 * deliberately not dismissable — the condition it describes does not go away
 * while that collection is on screen, so a close affordance would only let the
 * reader hide the reason the action beside it is unavailable.
 *
 * Carries no outer margin. Spacing is the caller's, since the same notice is
 * used inline under a picker and as a dialog's entire body.
 */
export function InlineNotice(props: {
  children: ReactNode;
  /** Applied alongside the notice's own class, for the caller's spacing. */
  className?: string;
}): JSX.Element {
  const { children, className } = props;
  const classes = useStyles();

  return (
    <Box className={className ? `${classes.notice} ${className}` : classes.notice}>
      <InfoOutlinedIcon className={classes.icon} />
      <Typography variant="body2" color="textSecondary">
        {children}
      </Typography>
    </Box>
  );
}
