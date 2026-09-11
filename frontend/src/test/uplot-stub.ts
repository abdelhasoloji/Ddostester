/**
 * Test stub for uPlot. jsdom has no real canvas, so the actual uPlot spline
 * renderer throws unhandled errors during draw. The app never asserts on the
 * chart pixels — only that chart components mount and update — so in tests we
 * alias `uplot` to this no-op (see vitest.config.ts). Production uses real uPlot.
 */
export default class UplotStub {
  static paths = { spline: () => () => {} };
  constructor(_opts?: unknown, _data?: unknown, _el?: HTMLElement) {}
  setData(): void {}
  setSize(): void {}
  destroy(): void {}
}
