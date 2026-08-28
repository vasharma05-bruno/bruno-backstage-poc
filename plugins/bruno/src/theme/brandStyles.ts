import { makeStyles } from '@material-ui/core/styles';
import { brunoBrand } from './brand';

/**
 * Shared brand treatments for Bruno surfaces.
 *
 * Every class here is additive on top of stock Material-UI: a `Button` keeps its
 * MUI shape, elevation and ripple and only picks up the brand colour, a `Chip`
 * stays a `Chip`. That is the whole split — Bruno's cards and controls read as
 * ordinary Backstage/MUI components, and the brand shows up as accent, never as
 * a different component language.
 */
export const useBrandStyles = makeStyles((theme) => {
  const brand = brunoBrand(theme);

  return {
    /** The accent rule drawn across the top of a Bruno card or dialog. */
    accentRule: {
      'position': 'relative',
      // Keeps the rule inside the card's rounded corners.
      'overflow': 'hidden',
      '&::before': {
        content: '""',
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 3,
        background: brand.rule,
        // Above the header wash so the rule stays crisp.
        zIndex: 1
      }
    },

    /** The Bruno mark, sized to sit on a title row. */
    mark: {
      fontSize: 22,
      flex: '0 0 auto'
    },

    /** Accent-coloured text — figures, emphasised labels. */
    accentText: {
      color: brand.accentText
    },

    /** A headline figure (stat tiles, the entity card's request count). */
    accentFigure: {
      color: brand.accentText,
      fontWeight: 700
    },

    /**
     * Brand-filled contained button: the primary Bruno action on a surface
     * ("Open in Bruno", "Add collection", the dashboard's OPEN).
     *
     * The state selectors are doubled (`&&`) on purpose. They compete with MUI's
     * own compound rules (`.MuiButton-contained:hover`,
     * `.MuiButton-contained.Mui-disabled`) at equal specificity, where the
     * winner would come down to stylesheet order — and losing the disabled rule
     * would leave a disabled button looking fully enabled.
     */
    accentButton: {
      'backgroundColor': brand.accent,
      'color': brand.onAccent,
      '&&:hover': {
        backgroundColor: brand.accentHover
      },
      '&&.Mui-disabled': {
        backgroundColor: theme.palette.action.disabledBackground,
        color: theme.palette.action.disabled
      }
    },

    /** Brand-tinted outlined button: secondary Bruno actions. */
    accentOutlinedButton: {
      'color': brand.accentText,
      'borderColor': brand.border,
      '&&:hover': {
        borderColor: brand.accent,
        backgroundColor: brand.wash
      }
    },

    /** Brand-tinted chip, for Bruno-owned metadata. */
    accentChip: {
      backgroundColor: brand.washStrong,
      color: brand.accentText,
      border: `1px solid ${brand.border}`
    },

    /** Brand-indicated tab bar. */
    accentTabs: {
      'borderBottom': `1px solid ${theme.palette.divider}`,
      '& .MuiTabs-indicator': {
        backgroundColor: brand.accent,
        height: 3
      },
      '& .MuiTab-textColorPrimary.Mui-selected': {
        color: brand.accentText
      }
    }
  };
});
