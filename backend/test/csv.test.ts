import { describe, expect, it } from 'vitest';
import { csvField, toCsv } from '../src/util/csv.js';

describe('csv', () => {
  it('quotes fields with commas, quotes or newlines', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField(null)).toBe('');
    expect(csvField(42)).toBe('42');
  });

  it('builds a document with a header and rows, trailing newline', () => {
    const out = toCsv(
      ['a', 'b'],
      [
        [1, 'x'],
        [2, 'y,z'],
      ],
    );
    expect(out).toBe('a,b\n1,x\n2,"y,z"\n');
  });
});
