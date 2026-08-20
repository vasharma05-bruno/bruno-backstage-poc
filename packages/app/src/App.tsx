import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import brunoPluginPoc from '@usebruno/bruno-plugin-poc';
import { navModule } from './modules/nav';
import { authModule } from './modules/auth';

export default createApp({
  features: [catalogPlugin, navModule, brunoPluginPoc, authModule],
});
