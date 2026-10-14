import { describe, expect, it } from 'vitest';
import { decodeGatling316Log } from '../src/agents/gatling-log.js';
// Native Gatling 3.16.0 output: dedicated loopback recipe, three finalized responses.
const fixture = Buffer.from(
  'AAAAAAYzLjE2LjAAAAAAFFNoaWVsZFRlc3RGcmFjdGlvbmFsAAAAAaE4EWXEAAAAAAAAAAEAAAAKc2hpZWxkdGVzdAAAAAAAAgAAAAABAAAEUQEAAAAAAAAAAQAAAANyZXEAAAAEXwAABG8BAAAAAgAAAAACAAAAAAAAAAR3AgAAAAABAAAEeAIAAAAAAQAABkcBAAAAAP////8AAAwzAAAMPQH////+AgAAAAAAAAAMPgIAAAAAAQAADD8BAAAAAP////8AABQDAAAUCgH////+AgAAAAAAAAAUCwIAAAAAAQAAFAw=',
  'base64',
);
describe('Gatling native binary measurements', () => {
  it('decodes the native response records and cached strings', () => {
    const rows = decodeGatling316Log(fixture).split('\n');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe('REQUEST\treq\t1791942027811\t1791942027827\tOK');
    expect(rows.every((row) => row.endsWith('\tOK'))).toBe(true);
  });
  it('rejects truncation, unknown record types and missing cache references', () => {
    expect(() => decodeGatling316Log(fixture.subarray(0, fixture.length - 1))).toThrow('Malformed');
    const unknown = Buffer.concat([fixture, Buffer.from([255])]);
    expect(() => decodeGatling316Log(unknown)).toThrow('Malformed');
    const missingCache = Buffer.alloc(9);
    missingCache[0] = 1;
    missingCache.writeInt32BE(-99, 5);
    expect(() => decodeGatling316Log(Buffer.concat([fixture, missingCache]))).toThrow('Malformed');
    expect(() => decodeGatling316Log(Buffer.alloc(0))).toThrow('Malformed');
  });
});
