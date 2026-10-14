/** Attempt every cleanup action, even when a previous dependency is unavailable.
 * Diagnostics deliberately omit exception messages (which may contain credentials).
 */
export async function cleanupFleet(
  runId: string,
  actions: { name: string; run: () => Promise<unknown> }[],
  report: (event: { event: 'fleet.cleanup.failed'; runId: string; action: string }) => void,
): Promise<void> {
  for (const action of actions) {
    try {
      await action.run();
    } catch {
      try {
        report({ event: 'fleet.cleanup.failed', runId, action: action.name });
      } catch {
        // Observability failures must not prevent the remaining cleanup actions.
      }
    }
  }
}
