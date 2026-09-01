/**
 * How long a registered collection may reasonably still be on its way into the
 * catalog.
 *
 * `POST /collections` stores a row; `BrunoCollectionEntityProvider` turns it
 * into an entity on its own schedule, so there is always a window in which the
 * collection exists and the catalog does not know it. Two screens have to draw
 * a line at the end of that window — modal 2, which stops polling and changes
 * what it says, and the dashboard's pending strip, which stops calling a row
 * "arriving shortly" and starts calling it stuck — and they must draw it in the
 * SAME place. Two copies of `refreshSeconds * 2 + 30` in two files is a pair
 * that can drift, and a strip that gives up before the dialog does (or after)
 * would tell one user two different stories about one collection.
 */

/**
 * How long past a create to keep expecting the entity, in seconds.
 *
 * Two full provider cycles plus a margin for the catalog's own stitching, off
 * the instance's real `bruno.schedule.frequencySeconds` rather than the 60 s
 * default — the figure travels on every create, delete and list response for
 * exactly this reason. Past the window the honest reading is not "it failed"
 * but "this is no longer just latency", and the two callers say so in their own
 * words.
 */
export function landingTimeoutSeconds(refreshSeconds: number): number {
  return refreshSeconds * 2 + 30;
}
