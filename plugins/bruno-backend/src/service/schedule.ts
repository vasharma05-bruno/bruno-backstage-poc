import type { SchedulerServiceTaskScheduleDefinition } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';

const DEFAULT_FREQUENCY_SECONDS = 60;
const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * How long a collection takes to appear in — or disappear from — the catalog
 * after it is added or removed from the Bruno UI.
 *
 * The same number `readSchedule` puts on the provider's task runner, read out
 * separately so `POST`/`DELETE /collections` can quote it back to the browser.
 * The dialogs would otherwise have to hardcode 60 and be silently wrong on any
 * instance that tuned `bruno.schedule.frequencySeconds` — telling a user to
 * wait a minute when their operator set five is worse than saying nothing.
 */
export function readRefreshSeconds(config: Config): number {
  return (
    config
      .getOptionalConfig('bruno.schedule')
      ?.getOptionalNumber('frequencySeconds') ?? DEFAULT_FREQUENCY_SECONDS
  );
}

/**
 * Reads `bruno.schedule` from config into a task schedule definition.
 *
 * Supports the POC contract's config shape (`frequencySeconds` /
 * `timeoutSeconds`, declared in `config.d.ts`) and falls back to sensible
 * defaults (every 60s, 30s timeout).
 */
export function readSchedule(config: Config): SchedulerServiceTaskScheduleDefinition {
  const scheduleConfig = config.getOptionalConfig('bruno.schedule');
  const frequencySeconds = readRefreshSeconds(config);
  const timeoutSeconds
    = scheduleConfig?.getOptionalNumber('timeoutSeconds')
      ?? DEFAULT_TIMEOUT_SECONDS;

  return {
    frequency: { seconds: frequencySeconds },
    timeout: { seconds: timeoutSeconds },
    // One replica sweeps, not N. The task re-reads every configured collection
    // from its SCM host, so `'local'` would multiply that traffic — and the API
    // rate limit it spends — by the replica count while buying no freshness.
    // This IS the scheduler's default, stated rather than inherited, because a
    // silent framework default is not something an adopter can audit.
    scope: 'global',
    // Give the backend a moment after boot before the first refresh.
    initialDelay: { seconds: 3 }
  };
}
