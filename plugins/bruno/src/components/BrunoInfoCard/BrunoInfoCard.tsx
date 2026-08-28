import type { ReactNode } from 'react';
import { InfoCard } from '@backstage/core-components';
import type { InfoCardVariants } from '@backstage/core-components';
import { makeStyles } from '@material-ui/core/styles';
import { brunoBrand } from '../../theme/brand';
import { useBrandStyles } from '../../theme/brandStyles';
import { BrunoIcon } from '../BrunoLogo';

const useStyles = makeStyles((theme) => {
  const brand = brunoBrand(theme);

  return {
    card: {
      // Brand wash behind the title row only. The body keeps the plain MUI card
      // surface so content reads exactly like every other Backstage card.
      '& .MuiCardHeader-root': {
        background: brand.wash,
        paddingTop: theme.spacing(2.25)
      }
    },
    titleRow: {
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1)
    }
  };
});

/**
 * A Bruno-branded `InfoCard`.
 *
 * Structurally it IS the Backstage `InfoCard` — same Material-UI `Card`,
 * `CardHeader`, divider and `CardContent`, same variants, same error boundary.
 * The branding is three additive touches that mark a card as Bruno's without
 * changing how it behaves: an accent rule across the top edge, a faint accent
 * wash behind the title row, and the Bruno mark leading the title.
 *
 * Pass no `title` (stat tiles) and the card keeps just the accent rule, since
 * `InfoCard` renders no header without one.
 */
export function BrunoInfoCard(props: {
  title?: ReactNode;
  subheader?: ReactNode;
  action?: ReactNode;
  variant?: InfoCardVariants;
  className?: string;
  noPadding?: boolean;
  /** Drop the leading Bruno mark — for cards whose title is already a mark. */
  hideMark?: boolean;
  children?: ReactNode;
}): JSX.Element {
  const {
    title,
    subheader,
    action,
    variant,
    className,
    noPadding,
    hideMark,
    children
  } = props;
  const classes = useStyles();
  const brandClasses = useBrandStyles();

  const cardClassName = [brandClasses.accentRule, classes.card, className]
    .filter(Boolean)
    .join(' ');

  return (
    <InfoCard
      className={cardClassName}
      variant={variant}
      noPadding={noPadding}
      action={action}
      subheader={subheader}
      title={
        title === undefined
          ? undefined
          : (
              <span className={classes.titleRow}>
                {!hideMark && <BrunoIcon className={brandClasses.mark} />}
                <span>{title}</span>
              </span>
            )
      }
    >
      {children}
    </InfoCard>
  );
}
