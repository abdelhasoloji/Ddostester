import { describe, it, expect, vi } from 'vitest';
import { htmlToPdf, pdfAvailable } from '../src/modules/reports/pdf.js';

describe('htmlToPdf', () => {
  it('returns null when no headless browser is available', async () => {
    const out = await htmlToPdf('<h1>x</h1>', async () => null);
    expect(out).toBeNull();
    expect(await pdfAvailable(async () => null)).toBe(false);
  });

  it('renders a PDF Buffer through the injected chromium', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const page = {
      setContent: vi.fn().mockResolvedValue(undefined),
      pdf: vi.fn().mockResolvedValue(pdfBytes),
    };
    const browser = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const chromium = { launch: vi.fn().mockResolvedValue(browser) };

    const out = await htmlToPdf('<h1>report</h1>', async () => chromium);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out?.toString('ascii')).toBe('%PDF');
    expect(page.setContent).toHaveBeenCalledWith('<h1>report</h1>', { waitUntil: 'load' });
    expect(browser.close).toHaveBeenCalled(); // browser is always closed
    expect(await pdfAvailable(async () => chromium)).toBe(true);
  });

  it('returns null (and still closes the browser) when rendering throws', async () => {
    const browser = {
      newPage: vi.fn().mockRejectedValue(new Error('boom')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const chromium = { launch: vi.fn().mockResolvedValue(browser) };
    const out = await htmlToPdf('<h1>x</h1>', async () => chromium);
    expect(out).toBeNull();
    expect(browser.close).toHaveBeenCalled();
  });
});
