import { AgentError } from './types.js';

/** RFC 4180 fields, including embedded commas/newlines and escaped quotes. */
export function parseMeasurementCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false;
  const finishField = () => {
    row.push(field);
    field = '';
    closed = false;
  };
  const finishRow = () => {
    finishField();
    if (row.some((value) => value !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += character;
    } else if (character === ',') finishField();
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[i + 1] === '\n') i++;
      finishRow();
    } else if (closed || (character === '"' && field !== '')) {
      throw new AgentError('Malformed measurement CSV quoting.');
    } else if (character === '"') quoted = true;
    else field += character;
  }
  if (quoted) throw new AgentError('Truncated measurement CSV field.');
  if (field !== '' || row.length || closed) finishRow();
  return rows;
}
