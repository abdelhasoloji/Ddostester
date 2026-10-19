/** Minimal, dependency-free CSV builder (RFC 4180 quoting). */

/** Neutralize spreadsheet formulas in text, preserving actual numeric cells. */
export function spreadsheetValue(value: unknown): string {
  const text = value == null ? '' : String(value);
  return typeof value === 'string' && /^(?:\s*[=+@-]|[\t\r])/.test(text) ? "'" + text : text;
}

/** Escapes one field: quote it when it contains a comma, quote or newline. */
export function csvField(value: unknown): string {
  const s = spreadsheetValue(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Builds a CSV document from a header row and data rows. Ends with a newline. */
export function toCsv(headers: string[], rows: (readonly unknown[])[]): string {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return lines.join('\n') + '\n';
}
