import { render, screen, waitFor } from '@testing-library/react';
import { TestApiProvider } from '@backstage/test-utils';
import { brunoApiRef } from '../../api';
import type { BrunoApi, DiscoverySweepReport } from '../../api';
import { IncompleteDiscovery } from './IncompleteDiscovery';

/**
 * A `BrunoApi` that answers `getDiscoveryReport` and nothing else.
 *
 * Cast rather than fully implemented on purpose: this component reaches exactly
 * one method, and stubbing the other six would state a dependency that does not
 * exist — a later method added to the interface should not drag this file with
 * it.
 */
function apiAnswering(
  getDiscoveryReport: BrunoApi['getDiscoveryReport']
): BrunoApi {
  return { getDiscoveryReport } as BrunoApi;
}

function renderStrip(api: BrunoApi) {
  return render(
    <TestApiProvider apis={[[brunoApiRef, api]]}>
      <IncompleteDiscovery />
    </TestApiProvider>
  );
}

const REPORT: DiscoverySweepReport = {
  sweptAt: '2026-09-18T10:00:00.000Z',
  incomplete: [
    {
      repository: 'acme/monorepo',
      host: 'github.com',
      found: 3,
      reason: 'listing-limit'
    }
  ]
};

describe('IncompleteDiscovery', () => {
  /**
   * The render-nothing contract, which is the component's most important
   * behaviour rather than a corner case: on a dashboard where autodiscovery is
   * healthy — or switched off — this must be invisible, with no heading, no
   * empty box and no placeholder.
   */
  it('renders nothing for a sweep with nothing incomplete', async () => {
    const getDiscoveryReport = jest
      .fn()
      .mockResolvedValue({ sweptAt: REPORT.sweptAt, incomplete: [] });
    const { container } = renderStrip(apiAnswering(getDiscoveryReport));

    await waitFor(() => expect(getDiscoveryReport).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  // `undefined` is the backend saying no sweep has ever been recorded, which is
  // a different fact from an empty report but the same thing on screen: there
  // is nothing to tell the user.
  it('renders nothing when no sweep has been recorded', async () => {
    const getDiscoveryReport = jest.fn().mockResolvedValue(undefined);
    const { container } = renderStrip(apiAnswering(getDiscoveryReport));

    await waitFor(() => expect(getDiscoveryReport).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  // An aid, never an error. A backend that is down, or too old to have the
  // route, must cost this strip and nothing else on the page.
  it('renders nothing when the read fails', async () => {
    const getDiscoveryReport = jest
      .fn()
      .mockRejectedValue(new Error('backend is down'));
    const { container } = renderStrip(apiAnswering(getDiscoveryReport));

    await waitFor(() => expect(getDiscoveryReport).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  /**
   * The copy test. Two properties are pinned rather than the whole sentence:
   * the count has to be on screen, because it is the only thing that tells an
   * operator whether they are missing one collection or fifty, and the word
   * "truncated" has to stay off it — that is GitHub's term for its own API
   * limit and means nothing to the person reading this.
   */
  it('names the repository, the count and the way out', async () => {
    renderStrip(apiAnswering(jest.fn().mockResolvedValue(REPORT)));

    const message = await screen.findByText(/acme\/monorepo/);
    expect(message.textContent).toContain('3 collections were found there');
    expect(message.textContent).toContain('bruno.collections');
    expect(message.textContent).not.toMatch(/truncat/i);
  });

  // Fetched once per mount and not polled: the condition is persistent, so a
  // copied poll would hold a timer on every open dashboard forever.
  it('reads the report once per mount', async () => {
    const getDiscoveryReport = jest.fn().mockResolvedValue(REPORT);
    renderStrip(apiAnswering(getDiscoveryReport));

    await screen.findByText(/acme\/monorepo/);
    expect(getDiscoveryReport).toHaveBeenCalledTimes(1);
  });
});
