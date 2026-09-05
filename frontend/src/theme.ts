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

/** Persists and applies a theme. */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem('theme', theme);
  } catch {
    /* ignore */
  }
  applyTheme(theme);
}
