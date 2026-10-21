import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { createZip } from '../src/util/zip.js';

// The bundle is a deliverable, so the archive has to be readable by normal tools. This parses
// the central directory back and inflates each entry rather than trusting the writer.
describe('zip writer', () => {
  it('writes a readable archive with UTF-8 names', () => {
    const zip = createZip([
      { name: 'report.json', data: '{"ok":true}' },
      { name: 'rapport-client.md', data: '# Rapport\n' },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);

    const endOffset = zip.length - 22;
    expect(zip.readUInt32LE(endOffset)).toBe(0x06054b50);
    const count = zip.readUInt16LE(endOffset + 10);
    expect(count).toBe(2);

    const centralOffset = zip.readUInt32LE(endOffset + 16);
    const names: string[] = [];
    let cursor = centralOffset;
    for (let i = 0; i < count; i++) {
      expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
      const nameLength = zip.readUInt16LE(cursor + 28);
      const compressedSize = zip.readUInt32LE(cursor + 20);
      const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      const localOffset = zip.readUInt32LE(cursor + 42);
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtra = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtra;
      const content = inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize)).toString(
        'utf8',
      );
      names.push(name);
      expect(content.length).toBeGreaterThan(0);
      cursor += 46 + nameLength;
    }
    expect(names).toEqual(['report.json', 'rapport-client.md']);
  });
});
