import { useTheme } from '@material-ui/core/styles';
import type { Theme } from '@material-ui/core/styles';

/**
 * The Bruno brand accent, kept as HSL components rather than finished colour
 * strings so every derived treatment (translucent washes, hover states, the
 * accessible text variant) comes off the same canonical hue instead of a pile
 * of hand-picked literals.
 *
 * Both stops are the brand's own values — the deeper orange for light surfaces,
 * the lifted amber for dark ones.
 */
const ACCENT = {
  light: { h: 33, s: 80, l: 46 },
  dark: { h: 39, s: 74, l: 59 }
} as const;

/**
 * Lightness used when the accent has to work as TEXT on a light surface.
 *
 * `hsl(33, 80%, 46%)` on white is only ~3.1:1, below WCAG AA for body copy, so
 * text-role usages darken to ~4.8:1 while fills/borders/indicators keep the
 * brand value exactly. The dark-mode accent already clears AA on dark paper and
 * is used unchanged.
 */
const LIGHT_TEXT_LIGHTNESS = 36;

/** Hover shift: light mode goes deeper, dark mode goes brighter. */
const LIGHT_HOVER_LIGHTNESS = 40;
const DARK_HOVER_LIGHTNESS = 66;

interface Hsl {
  h: number;
  s: number;
  l: number;
}

const hsl = (c: Hsl, lightness: number = c.l): string =>
  `hsl(${c.h}, ${c.s}%, ${lightness}%)`;

const hsla = (c: Hsl, alpha: number, lightness: number = c.l): string =>
  `hsla(${c.h}, ${c.s}%, ${lightness}%, ${alpha})`;

/**
 * Brand tokens for the active theme mode. Components consume these by name so
 * the two brand values live in exactly one place.
 */
export interface BrunoBrand {
  /** True when the app is in dark mode. */
  dark: boolean;
  /** The brand accent, unmodified. Fills, borders, rules, indicators. */
  accent: string;
  /** Hover/active variant of `accent`. */
  accentHover: string;
  /** Accent as readable text on the card surface (AA-checked). */
  accentText: string;
  /** Foreground to place on top of an `accent` fill. */
  onAccent: string;
  /** Faint accent wash — card header / hero surfaces. */
  wash: string;
  /** Stronger accent wash — chips, hover surfaces. */
  washStrong: string;
  /** Hairline accent border. */
  border: string;
  /** The accent rule drawn across the top of every Bruno card. */
  rule: string;
}

/**
 * Derives the brand tokens from a Material-UI theme. A plain function (not just
 * a hook) so `makeStyles((theme) => …)` blocks can reach the tokens too.
 */
export function brunoBrand(theme: Theme): BrunoBrand {
  const dark = theme.palette.type === 'dark';
  const base = dark ? ACCENT.dark : ACCENT.light;

  return {
    dark,
    accent: hsl(base),
    accentHover: hsl(
      base,
      dark ? DARK_HOVER_LIGHTNESS : LIGHT_HOVER_LIGHTNESS
    ),
    accentText: dark ? hsl(base) : hsl(base, LIGHT_TEXT_LIGHTNESS),
    // Dark-on-accent in both modes: the accent's luminance gives 6.8:1 against
    // near-black in light mode and 10.4:1 in dark mode, where white would only
    // reach 3.1:1 / 2.0:1.
    onAccent: 'rgba(0, 0, 0, 0.87)',
    wash: hsla(base, dark ? 0.1 : 0.08),
    washStrong: hsla(base, dark ? 0.2 : 0.14),
    border: hsla(base, dark ? 0.4 : 0.35),
    rule: `linear-gradient(90deg, ${hsl(base)} 0%, ${hsla(base, 0.25)} 100%)`
  };
}

/** Brand tokens for the active theme mode. */
export function useBrunoBrand(): BrunoBrand {
  return brunoBrand(useTheme());
}
