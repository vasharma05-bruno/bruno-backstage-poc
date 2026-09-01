import { useState } from 'react';
import Snackbar from '@material-ui/core/Snackbar';
import {
  buildBrunoDeepLink,
  buildCloneInstruction
} from '../../lib/brunoLink';

/** The two things "Open in Bruno" can do, plus the snackbar they report through. */
export interface OpenInBrunoActions {
  /** Opens the collection through Bruno's hosted fetch endpoint, in a new tab. */
  openDeepLink: () => void;
  /** Fallback: copies a `git clone` instruction, or shows it if the clipboard is unavailable. */
  copyCloneInstruction: () => Promise<void>;
  /** The message to show, or `null`. Render {@link OpenInBrunoSnackbar} with it. */
  snack: string | null;
  dismissSnack: () => void;
}

/**
 * The behaviour behind "Open in Bruno": the deep link and its clipboard
 * fallback.
 *
 * A hook and not a component, because neither surface wants a button handed to
 * it — the Bruno Collections card drives this from a row-action menu item
 * ("Fetch in Bruno"), and the entity header renders its own control off
 * `buildBrunoDeepLink`. Keeping the two behaviours here is what stops either
 * surface from reimplementing them.
 */
export function useOpenInBruno(sourceUrl?: string): OpenInBrunoActions {
  const [snack, setSnack] = useState<string | null>(null);

  return {
    openDeepLink: () => {
      if (!sourceUrl) {
        return;
      }
      // Hand the collection URL to Bruno's hosted fetch endpoint in a new tab so
      // we don't navigate the user away from Backstage.
      window.open(
        buildBrunoDeepLink(sourceUrl),
        '_blank',
        'noopener,noreferrer'
      );
    },
    copyCloneInstruction: async () => {
      if (!sourceUrl) {
        return;
      }
      const text = buildCloneInstruction(sourceUrl);
      try {
        await navigator.clipboard.writeText(text);
        setSnack('Clone instruction copied to clipboard');
      } catch {
        // Clipboard may be unavailable (insecure context) — show the command.
        setSnack(text);
      }
    },
    snack,
    dismissSnack: () => setSnack(null)
  };
}

/**
 * The snackbar the clipboard fallback reports through. A separate component
 * because a `Snackbar` cannot be a child of a Material-UI `Menu` — the menu
 * clones its children into its keyboard-navigable item list — so the menu's host
 * has to render it as a sibling.
 */
export function OpenInBrunoSnackbar(props: {
  actions: OpenInBrunoActions;
}): JSX.Element {
  const { snack, dismissSnack } = props.actions;
  return (
    <Snackbar
      open={Boolean(snack)}
      autoHideDuration={6000}
      onClose={dismissSnack}
      message={snack ?? ''}
    />
  );
}
