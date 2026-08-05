import { useState } from 'react';
import Button from '@material-ui/core/Button';
import Menu from '@material-ui/core/Menu';
import MenuItem from '@material-ui/core/MenuItem';
import Tooltip from '@material-ui/core/Tooltip';
import Snackbar from '@material-ui/core/Snackbar';
import LaunchIcon from '@material-ui/icons/Launch';
import ArrowDropDownIcon from '@material-ui/icons/ArrowDropDown';
import {
  buildBrunoDeepLink,
  buildCloneInstruction
} from '../../lib/brunoLink';

/**
 * "Open in Bruno" split action.
 *
 * Primary button attempts the `bruno://open` deep link (a Beta desktop
 * dependency — see docs/POC-DECISIONS.md D3/Q3; today Bruno desktop only
 * handles `bruno://app/oauth2/callback`). The dropdown offers a
 * "Clone & open in Bruno" fallback that copies a `git clone` instruction.
 */
export function OpenInBruno(props: { sourceUrl?: string }) {
  const { sourceUrl } = props;
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [snack, setSnack] = useState<string | null>(null);

  if (!sourceUrl) {
    return (
      <Tooltip title="No bruno.dev/source-url annotation on this entity">
        <span>
          <Button variant="contained" color="primary" disabled>
            Open in Bruno
          </Button>
        </span>
      </Tooltip>
    );
  }

  const openDeepLink = () => {
    // Attempt to hand off to the desktop app. If no handler is registered the
    // browser simply does nothing (or shows a "no app" dialog).
    window.location.href = buildBrunoDeepLink(sourceUrl);
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
      <Tooltip title="Direct bruno:// open is a Beta desktop dependency (today Bruno handles only bruno://app/oauth2/callback). Use 'Clone & open' as a fallback.">
        <span style={{ display: 'inline-flex' }}>
          <Button
            variant="contained"
            color="primary"
            startIcon={<LaunchIcon />}
            onClick={openDeepLink}
            style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
          >
            Open in Bruno
          </Button>
          <Button
            variant="contained"
            color="primary"
            size="small"
            aria-label="More open options"
            onClick={(e) => setAnchorEl(e.currentTarget)}
            style={{
              minWidth: 32,
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
              borderLeft: '1px solid rgba(255,255,255,0.3)'
            }}
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
