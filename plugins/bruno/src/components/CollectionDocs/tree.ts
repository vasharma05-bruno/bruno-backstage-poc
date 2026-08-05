import type { Item, RequestItem } from '../../api/types';
import { isFolderItem, isRequestItem } from '../../api/types';

/** A request paired with a stable id derived from its path in the tree. */
export interface FlatRequest {
  id: string;
  item: RequestItem;
}

/**
 * Walk the collection items depth-first and produce a stable id for each
 * request (path-based), so the tree and detail pane can reference the same
 * selection key.
 */
export function flattenRequests(items: Item[], prefix = ''): FlatRequest[] {
  const out: FlatRequest[] = [];
  items.forEach((item, idx) => {
    const id = `${prefix}${idx}`;
    if (isFolderItem(item)) {
      out.push(...flattenRequests(item.items, `${id}.`));
    } else if (isRequestItem(item)) {
      out.push({ id, item });
    }
  });
  return out;
}

/** Return the request id for the first request in the tree, if any. */
export function firstRequestId(items: Item[]): string | undefined {
  return flattenRequests(items)[0]?.id;
}
