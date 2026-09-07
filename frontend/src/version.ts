// Build-time constants injected by Vite's `define` (see vite.config.ts). The
// `typeof` guards keep this safe under test runners that don't apply `define`.
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILT__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
export const APP_COMMIT: string = typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : 'dev';
export const APP_BUILT: string = typeof __APP_BUILT__ !== 'undefined' ? __APP_BUILT__ : '';

/** Short label for the footer, e.g. "v0.1.0 · 60a4fcd". */
export const APP_VERSION_LABEL = `v${APP_VERSION} · ${APP_COMMIT}`;
