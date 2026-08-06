import type { SchedulerServiceTaskScheduleDefinition } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';

const DEFAULT_FREQUENCY_SECONDS = 60;
const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Reads `bruno.schedule` from config into a task schedule definition.
 *
 * Supports the POC contract's config shape (`frequencySeconds` /
 * `timeoutSeconds`, see docs/POC-DECISIONS.md §3) and falls back to sensible
 * defaults (every 60s, 30s timeout).
 */
export function readSchedule(config: Config): SchedulerServiceTaskScheduleDefinition {
  const scheduleConfig = config.getOptionalConfig('bruno.schedule');
  const frequencySeconds
    = scheduleConfig?.getOptionalNumber('frequencySeconds')
      ?? DEFAULT_FREQUENCY_SECONDS;
  const timeoutSeconds
    = scheduleConfig?.getOptionalNumber('timeoutSeconds')
      ?? DEFAULT_TIMEOUT_SECONDS;

  return {
    frequency: { seconds: frequencySeconds },
    timeout: { seconds: timeoutSeconds },
    // Give the backend a moment after boot before the first refresh.
    initialDelay: { seconds: 3 }
  };
}
