/**
 * How long a registered collection may reasonably still be on its way into the
 * catalog.
 *
 * `POST /collections` stores a row; `BrunoCollectionEntityProvider` turns it
 * into an entity on its own schedule, so there is always a window in which the
 * collection exists and the catalog does not know it. The dashboard's pending
 * strip has to draw a line at the end of that window: before it, a row is
 * "arriving shortly"; after it, the row is stuck and the strip says so and
 * offers a Remove.
 *
 * Its own module for one caller, deliberately. This used to be shared with the
 * add-collection flow's modal 2, which polled the catalog over the same window
 * — that dialog no longer waits for anything (the pull-request path registers
 * nothing, so there is no entity on its way), and the threshold outlived the
 * pairing because it is a real, named policy rather than an inline constant. It
 * is also the number most likely to want tuning, and the reasoning below is what
 * has to be re-read before anyone tunes it.
 */

/**
 * How long past a create to keep expecting the entity, in seconds.
 *
 * Two full provider cycles plus a margin for the catalog's own stitching, off
 * the instance's real `bruno.schedule.frequencySeconds` rather than the 60 s
 * default — the figure travels on every create, delete and list response for
 * exactly this reason. Past the window the honest reading is not "it failed"
 * but "this is no longer just latency", and the caller says so in its own
 * words.
 */
export function landingTimeoutSeconds(refreshSeconds: number): number {
  return refreshSeconds * 2 + 30;
}
