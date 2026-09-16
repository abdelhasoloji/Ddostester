/**
 * Guarded localStorage access. In private-mode browsers and sandboxed iframes
 * `localStorage` can throw on access (not just on write) — an unguarded read in
 * a module initializer or a `useState` initializer takes the whole app down
 * before it renders. Every localStorage touch in the app goes through these so a
 * disabled store degrades to "no persistence", never a blank screen.
 */

/** Reads a key, returning null on any failure (missing, or storage disabled). */
export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Writes a key; a no-op when storage is unavailable. */
export function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage disabled — best-effort */
  }
}

/** Removes a key; a no-op when storage is unavailable. */
export function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage disabled — best-effort */
  }
}
