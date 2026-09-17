/**
 * `scope: 'global'` is the invariant worth a test: the refresh task re-reads
 * every configured collection from its SCM host, and `'local'` would multiply
 * that traffic by the replica count. It is also the scheduler's own default, so
 * nothing FAILS if the key is dropped — the cost just appears in someone else's
 * rate limit. A test is the only thing that notices.
 */
import { ConfigReader } from '@backstage/config';
import { readRefreshSeconds, readSchedule } from './schedule';

describe('readSchedule', () => {
  it('locks the sweep to one replica', () => {
    expect(readSchedule(new ConfigReader({})).scope).toBe('global');
    expect(
      readSchedule(
        new ConfigReader({ bruno: { schedule: { frequencySeconds: 5 } } })
      ).scope
    ).toBe('global');
  });

  it('falls back to 60s / 30s when `bruno.schedule` is absent', () => {
    expect(readSchedule(new ConfigReader({}))).toMatchObject({
      frequency: { seconds: 60 },
      timeout: { seconds: 30 },
      initialDelay: { seconds: 3 }
    });
  });

  it('reads both tunables independently', () => {
    const schedule = readSchedule(
      new ConfigReader({ bruno: { schedule: { timeoutSeconds: 90 } } })
    );

    expect(schedule).toMatchObject({
      frequency: { seconds: 60 },
      timeout: { seconds: 90 }
    });
  });
});

describe('readRefreshSeconds', () => {
  it('quotes back the same number the task runner is given', () => {
    const config = new ConfigReader({
      bruno: { schedule: { frequencySeconds: 5 } }
    });

    // The dialogs tell the user how long to wait; the two must not drift.
    expect(readRefreshSeconds(config)).toBe(5);
    expect(readSchedule(config).frequency).toEqual({ seconds: 5 });
  });
});
