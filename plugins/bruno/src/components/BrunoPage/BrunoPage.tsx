import { useState } from 'react';
import { Content } from '@backstage/core-components';
import Box from '@material-ui/core/Box';
import Tabs from '@material-ui/core/Tabs';
import Tab from '@material-ui/core/Tab';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import { brunoBrand } from '../../theme/brand';
import { BrunoIcon } from '../BrunoLogo';
import { useBrandStyles } from '../../theme/brandStyles';
import { CollectionsTab } from './CollectionsTab';
import { LinkApiTab } from './LinkApi';

const useStyles = makeStyles((theme) => {
  const brand = brunoBrand(theme);

  return {
    // Brand strip under the app header. Deliberately a tagline rather than a
    // second title — PageLayout already supplies the "Bruno" heading.
    banner: {
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1.5),
      padding: theme.spacing(1.5, 2),
      marginBottom: theme.spacing(2),
      borderRadius: theme.shape.borderRadius,
      borderLeft: `3px solid ${brand.accent}`,
      background: brand.wash
    },
    bannerMark: {
      fontSize: 30,
      flex: '0 0 auto'
    }
  };
});

/**
 * Content-only root of the Bruno page (new frontend system). The page header is
 * supplied by the PageLayout, so this renders no `<Page>`/`<Header>` — just a
 * brand strip, an in-body tab bar (Collections and Link API) and the active tab,
 * with the body wrapped in core-components `Content`.
 */
export function BrunoPage(): JSX.Element {
  const classes = useStyles();
  const brandClasses = useBrandStyles();
  const [tab, setTab] = useState(0);
  // In-page deep-link (D9): clicking "Link" on an imported stub card jumps to
  // the Link API tab with the imported collection preselected. No router.
  const [preselectImported, setPreselectImported] = useState<
    string | undefined
  >();

  return (
    <Content>
      <Box className={classes.banner}>
        <BrunoIcon className={classes.bannerMark} />
        <Box>
          <Typography variant="subtitle2">Bruno collections</Typography>
          <Typography variant="body2" color="textSecondary">
            API collections, docs and entity links — read straight from your
            Bruno repositories.
          </Typography>
        </Box>
      </Box>

      <Tabs
        className={brandClasses.accentTabs}
        value={tab}
        onChange={(_e, value) => {
          setTab(value);
          // Clear a one-shot deep-link preselect so it can't force-re-select a
          // stale collection when the user later opens the Link tab manually (D9).
          if (value !== 1) {
            setPreselectImported(undefined);
          }
        }}
        indicatorColor="primary"
        textColor="primary"
      >
        <Tab label="Collections" />
        <Tab label="Link API" />
      </Tabs>
      <Box mt={2}>
        {tab === 0 ? (
          <CollectionsTab
            onRequestLink={(id) => {
              setPreselectImported(id);
              setTab(1);
            }}
          />
        ) : (
          <LinkApiTab preselectImportedCollectionId={preselectImported} />
        )}
      </Box>
    </Content>
  );
}
