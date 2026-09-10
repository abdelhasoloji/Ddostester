/**
 * Server-side PDF export for the HTML reports. The reports are print-quality
 * HTML (see layout.ts `@media print`); this renders them to a paginated PDF via
 * a headless Chromium when one is available — so a client assessment PDF can be
 * generated programmatically (emailed, attached to a ticket) without a human
 * clicking "Print".
 *
 * Chromium is OPTIONAL: it's loaded via a dynamic import of Playwright (a dev
 * dependency, not shipped to the runtime by default). When it isn't installed
 * the loader returns null and the caller falls back to serving the HTML — the
 * feature is inert until `playwright` + `npx playwright install chromium` are
 * present on the host. Never throws.
 */

/** Resolves Playwright's `chromium`, or null when Playwright isn't installed. */
export type ChromiumLoader = () => Promise<unknown | null>;

const defaultLoader: ChromiumLoader = async () => {
  try {
    // Optional: absent on a production install → import throws → null.
    const mod = (await import('@playwright/test')) as { chromium?: unknown };
    return mod.chromium ?? null;
  } catch {
    return null;
  }
};

// Minimal structural typing of the slice of Playwright we use, so we don't
// depend on its types at the call site.
interface MiniPage {
  setContent(html: string, opts?: unknown): Promise<void>;
  pdf(opts?: unknown): Promise<Uint8Array>;
}
interface MiniBrowser {
  newPage(): Promise<MiniPage>;
  close(): Promise<void>;
}
interface MiniChromium {
  launch(opts?: unknown): Promise<MiniBrowser>;
}

/**
 * Renders `html` to an A4 PDF Buffer, or null if no headless browser is
 * available (or rendering failed). Safe to call unconditionally.
 */
export async function htmlToPdf(
  html: string,
  loadChromium: ChromiumLoader = defaultLoader,
): Promise<Buffer | null> {
  const chromium = (await loadChromium()) as MiniChromium | null;
  if (!chromium) return null;
  let browser: MiniBrowser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const bytes = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '20mm', left: '14mm', right: '14mm' },
    });
    return Buffer.from(bytes);
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/** True when server-side PDF rendering is available on this host. */
export async function pdfAvailable(loadChromium: ChromiumLoader = defaultLoader): Promise<boolean> {
  return (await loadChromium()) != null;
}
