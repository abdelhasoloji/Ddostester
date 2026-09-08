/** Extracts the hostname from a URL, returning the input unchanged if it isn't
 * a parseable URL (already a bare host). Shared by the report/notify modules. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
