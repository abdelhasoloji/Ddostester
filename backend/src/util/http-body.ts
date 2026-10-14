/** Read at most limit bytes, cancelling oversized responses before buffering them. */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  capture = true,
  captureLimit = limit,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let captured = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error('HTTP response exceeds byte budget');
      }
      bytes += value.byteLength;
      if (capture && captured < captureLimit) {
        const chunk = value.slice(0, captureLimit - captured);
        chunks.push(chunk);
        captured += chunk.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(capture ? captured : 0);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
