export type Theme = 'system' | 'light' | 'dark';

/** Reads the saved theme preference (defaults to 'system'). */
export function getTheme(): Theme {
  try {
    const t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark' || t === 'system') return t;
  } catch {
    /* storage may be unavailable */
  }
  return 'system';
}

/** Applies a theme to the document root: 'system' follows the OS preference. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

// A tiny reactive store so every theme control on screen stays in sync: without
// it, two independent `useState(getTheme)` copies (sidebar toggle + My account)
// drift — changing one leaves the other's active state stale until remount.
const listeners = new Set<() => void>();

/** Subscribe to theme changes (for React's useSyncExternalStore). Returns an unsubscribe. */
export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Persists and applies a theme, then notifies every subscriber. */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem('theme', theme);
  } catch {
    /* ignore */
  }
  applyTheme(theme);
  listeners.forEach((l) => l());
}
