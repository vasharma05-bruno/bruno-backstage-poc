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

  return (
    <Content>
      <Tabs
        value={tab}
        onChange={(_e, value) => setTab(value)}
        indicatorColor="primary"
        textColor="primary"
      >
        <Tab label="Collections" />
        <Tab label="Link API" />
      </Tabs>
      {tab === 0 ? <CollectionsTab /> : <LinkApiTab />}
    </Content>
  );
}
