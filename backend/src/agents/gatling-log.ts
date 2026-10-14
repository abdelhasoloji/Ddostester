import { AgentError } from './types.js';
import { IO_LIMITS } from '../config/limits.js';

/** Gatling 3.16.0 LogFileDataWriter wire format (big-endian numbers).
 * Only finalized native responses are represented; starts/status codes are absent.
 */
export function decodeGatling316Log(data: Buffer): string {
  if (data.length > IO_LIMITS.processStreamBytes)
    throw new AgentError('Gatling log exceeds byte budget.');
  let offset = 0;
  const cache = new Map<number, string>();
  const fail = (): never => {
    throw new AgentError('Malformed or unsupported Gatling binary log.');
  };
  const take = (size: number): Buffer => {
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > data.length) fail();
    const bytes = data.subarray(offset, offset + size);
    offset += size;
    return bytes;
  };
  const int = () => take(4).readInt32BE();
  const byte = () => take(1)[0];
  const bool = () => {
    const value = byte();
    if (value > 1) fail();
    return value === 1;
  };
  const count = () => {
    const value = int();
    if (value < 0 || value > data.length) fail();
    return value;
  };
  const string = (): string => {
    const size = count();
    if (size === 0) return '';
    const bytes = take(size);
    const coder = byte();
    if (coder > 1 || (coder === 1 && size % 2)) fail();
    return bytes.toString(coder === 0 ? 'latin1' : 'utf16le');
  };
  const cachedString = (): string => {
    const index = int();
    if (index < 0) return cache.get(-index) ?? fail();
    if (index !== cache.size + 1) fail();
    const value = string();
    cache.set(index, value);
    return value;
  };
  const groups = () => {
    const size = count();
    for (let i = 0; i < size; i++) cachedString();
  };
  if (byte() !== 0 || string() !== '3.16.0') fail();
  string(); // simulation class
  const start = Number(take(8).readBigInt64BE());
  if (!Number.isSafeInteger(start) || start < 1e12) fail();
  string(); // description
  const scenarios = count();
  for (let i = 0; i < scenarios; i++) string();
  const assertions = count();
  for (let i = 0; i < assertions; i++) take(count());
  const requests: string[] = [];
  while (offset < data.length) {
    const type = byte();
    if (type === 1) {
      groups();
      cachedString();
      const from = int();
      const to = int();
      if (from < 0 || to < from) fail();
      const ok = bool();
      cachedString();
      requests.push(`REQUEST\treq\t${start + from}\t${start + to}\t${ok ? 'OK' : 'KO'}`);
    } else if (type === 2) {
      const scenario = int();
      if (scenario < 0 || scenario >= scenarios) fail();
      bool();
      if (int() < 0) fail();
    } else if (type === 3) {
      groups();
      int();
      int();
      int();
      bool();
    } else if (type === 4) {
      cachedString();
      int();
    } else fail();
  }
  return requests.join('\n');
}
