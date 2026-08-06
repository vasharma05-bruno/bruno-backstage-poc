type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

/** Subscribe to connect/disconnect changes for one entity. Returns an unsubscribe fn. */
export function subscribeConnectionChange(entityRef: string, cb: Listener): () => void {
  let set = listeners.get(entityRef);
  if (!set) {
    set = new Set();
    listeners.set(entityRef, set);
  }
  set.add(cb);
  return () => {
    const s = listeners.get(entityRef);
    if (s) {
      s.delete(cb);
      if (s.size === 0) listeners.delete(entityRef);
    }
  };
}

/** Notify subscribers that an entity's Bruno connection changed. */
export function emitConnectionChange(entityRef: string): void {
  const s = listeners.get(entityRef);
  if (s) {
    for (const cb of [...s]) cb();
  }
}
