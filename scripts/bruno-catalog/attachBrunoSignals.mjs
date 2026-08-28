/**
 * Re-attaches the request signals that `brunoToOpenCollection` drops.
 *
 * The converter's output carries `info`, `http` (method/url/params/headers/
 * body/auth), `settings`, `docs` and `examples` — but NOT the `assert` block,
 * the `tests` block or the pre/post-request `script`s. Those are exactly where
 * a Bruno collection records what status codes an endpoint returns
 * (`res.status: eq 200`, `expect(res.getStatus()).to.equal(201)`), which is the
 * only response evidence most collections have. Dropping them would leave
 * nearly every operation documented as a bare `default` response.
 *
 * The two trees are walked in lockstep and matched by name within each level
 * (falling back to position for duplicate names), then the signals are copied
 * onto the OpenCollection item where `openCollectionToOpenApi` looks for them.
 */

/**
 * @param {object} oc         OpenCollection doc from `brunoToOpenCollection`
 * @param {object} collection the Bruno model that produced it
 * @returns {number} how many items were enriched
 */
export function attachBrunoSignals(oc, collection) {
  return walk(oc.items ?? [], collection.items ?? []);
}

function walk(ocItems, brunoItems) {
  const pool = indexByName(brunoItems);
  let enriched = 0;

  ocItems.forEach((ocItem, position) => {
    const name = ocItem.info?.name;
    const brunoItem = take(pool, name, position);
    if (!brunoItem) {
      return;
    }

    const isFolder = Array.isArray(ocItem.items) && !ocItem.http;
    if (isFolder) {
      enriched += walk(ocItem.items, brunoItem.items ?? []);
      return;
    }

    const request = brunoItem.request;
    if (!request) {
      return;
    }

    if (request.assertions?.length) {
      ocItem.assertions = request.assertions;
    }
    if (request.tests) {
      ocItem.tests = request.tests;
    }
    if (request.script?.req || request.script?.res) {
      ocItem.script = {
        req: request.script.req ?? null,
        res: request.script.res ?? null
      };
    }
    if (ocItem.assertions || ocItem.tests || ocItem.script) {
      enriched += 1;
    }
  });

  return enriched;
}

/** name -> queue of matching items, so repeated names resolve in order. */
function indexByName(items) {
  const map = new Map();
  items.forEach((item, index) => {
    const key = item.name ?? item.info?.name ?? `#${index}`;
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push({ item, index });
  });
  return { map, byIndex: items };
}

/**
 * Pops the next Bruno item matching `name`. Falls back to the item at the same
 * position when names disagree — the converter preserves order, so position is
 * a sound backstop for unnamed or renamed items.
 */
function take(pool, name, position) {
  const queue = pool.map.get(name);
  if (queue?.length) {
    return queue.shift().item;
  }
  return pool.byIndex[position];
}
