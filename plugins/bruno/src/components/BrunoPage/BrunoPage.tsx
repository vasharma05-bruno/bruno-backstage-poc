import { useState } from 'react';
import { Content } from '@backstage/core-components';
import Tabs from '@material-ui/core/Tabs';
import Tab from '@material-ui/core/Tab';
import { CollectionsTab } from './CollectionsTab';
import { LinkApiTab } from './LinkApi';

/**
 * Content-only root of the Bruno page (new frontend system). The page header is
 * supplied by the PageLayout, so this renders no `<Page>`/`<Header>` — just an
 * in-body tab bar (Collections and Link API) with the body wrapped in
 * core-components `Content`.
 */
export function BrunoPage(): JSX.Element {
  const [tab, setTab] = useState(0);
  // In-page deep-link (D9): clicking "Link" on an imported stub card jumps to
  // the Link API tab with the imported collection preselected. No router.
  const [preselectImported, setPreselectImported] = useState<
    string | undefined
  >();

  return (
    <Content>
      <Tabs
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
    </Content>
  );
}
