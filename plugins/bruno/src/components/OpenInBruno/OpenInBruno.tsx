import { useState } from 'react';
import Button from '@material-ui/core/Button';
import Menu from '@material-ui/core/Menu';
import MenuItem from '@material-ui/core/MenuItem';
import Tooltip from '@material-ui/core/Tooltip';
import Snackbar from '@material-ui/core/Snackbar';
import ArrowDropDownIcon from '@material-ui/icons/ArrowDropDown';
import LaunchIcon from '@material-ui/icons/Launch';
import { makeStyles } from '@material-ui/core/styles';
import {
  buildBrunoDeepLink,
  buildCloneInstruction
} from '../../lib/brunoLink';
import { useBrandStyles } from '../../theme/brandStyles';

const useStyles = makeStyles({
  group: {
    display: 'inline-flex'
  },
  // The two halves are separate Buttons rather than a ButtonGroup so the
  // Tooltip can wrap both; these rules fuse them into one control.
  primary: {
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0
  },
  toggle: {
    minWidth: 32,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    // Matches the dark-on-accent foreground.
    borderLeft: '1px solid rgba(0, 0, 0, 0.25)'
  }
});

/**
 * "Open in Bruno" split action — the flagship Bruno action on any surface, so
 * it wears the brand accent while staying a stock Material-UI contained button.
 * The leading icon stays the launch glyph rather than the Bruno mark: the accent
 * fill already says Bruno, the mark's tan face barely reads against it, and
 * "this opens somewhere else" is the thing worth signalling.
 *
 * Primary button opens the collection via Bruno's hosted fetch endpoint
 * (`https://fetch.usebruno.com/?url=<repoUrl>`) in a new tab. The dropdown
 * offers a "Clone & open in Bruno" fallback that copies a `git clone`
 * instruction.
 */
export function OpenInBruno(props: { sourceUrl?: string }) {
  const { sourceUrl } = props;
  const classes = useStyles();
  const brandClasses = useBrandStyles();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [snack, setSnack] = useState<string | null>(null);

  if (!sourceUrl) {
    return (
      <Tooltip title="No bruno.dev/source-url annotation on this entity">
        <span>
          <Button
            variant="contained"
            className={brandClasses.accentButton}
            startIcon={<LaunchIcon />}
            disabled
          >
            Open in Bruno
          </Button>
        </span>
      </Tooltip>
    );
  }

  const openDeepLink = () => {
    // Hand the collection URL to Bruno's hosted fetch endpoint in a new tab so
    // we don't navigate the user away from Backstage.
    window.open(
      buildBrunoDeepLink(sourceUrl),
      '_blank',
      'noopener,noreferrer'
    );
  };

  const copyCloneInstruction = async () => {
    setAnchorEl(null);
    const text = buildCloneInstruction(sourceUrl);
    try {
      await navigator.clipboard.writeText(text);
      setSnack('Clone instruction copied to clipboard');
    } catch {
      // Clipboard may be unavailable (insecure context) — show the command.
      setSnack(text);
    }
  };

  return (
    <>
      <Tooltip title="Opens the collection in Bruno via fetch.usebruno.com. Use 'Clone & open' as a fallback.">
        <span className={classes.group}>
          <Button
            variant="contained"
            className={`${brandClasses.accentButton} ${classes.primary}`}
            startIcon={<LaunchIcon />}
            onClick={openDeepLink}
          >
            Open in Bruno
          </Button>
          <Button
            variant="contained"
            size="small"
            className={`${brandClasses.accentButton} ${classes.toggle}`}
            aria-label="More open options"
            onClick={(e) => setAnchorEl(e.currentTarget)}
          >
            <ArrowDropDownIcon />
          </Button>
        </span>
      </Tooltip>
      <Menu
        anchorEl={anchorEl}
        keepMounted
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
      >
        <MenuItem onClick={copyCloneInstruction}>
          Clone &amp; open in Bruno (copy git clone)
        </MenuItem>
      </Menu>
      <Snackbar
        open={Boolean(snack)}
        autoHideDuration={6000}
        onClose={() => setSnack(null)}
        message={snack ?? ''}
      />
    </>
  );
}
