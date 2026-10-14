import { createHash, sign, verify } from 'node:crypto';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function content(checkpoint, previousRecordHash) {
  if (
    checkpoint.schemaVersion !== 1 ||
    checkpoint.verified !== true ||
    !Number.isSafeInteger(checkpoint.count) ||
    checkpoint.count < 0 ||
    !/^([0-9a-f]{64}|GENESIS)$/.test(checkpoint.headHash) ||
    !/^([0-9a-f]{64}|GENESIS)$/.test(checkpoint.previousAuditHead) ||
    !Number.isFinite(Date.parse(checkpoint.at))
  )
    throw new Error('Invalid audit checkpoint');
  return {
    schemaVersion: 1,
    at: checkpoint.at,
    headHash: checkpoint.headHash,
    count: checkpoint.count,
    previousAuditHead: checkpoint.previousAuditHead,
    previousRecordHash,
  };
}
export function signWitness(checkpoint, previous, privateKey) {
  if (previous && checkpoint.previousAuditHead !== previous.content.headHash)
    throw new Error('Audit continuity mismatch');
  const value = content(checkpoint, previous ? hash(previous) : 'GENESIS');
  return {
    content: value,
    signature: sign(null, Buffer.from(JSON.stringify(value)), privateKey).toString('base64'),
  };
}
export function verifyWitnesses(records, publicKey) {
  let previous;
  for (const record of records) {
    const value = content({ ...record.content, verified: true }, record.content.previousRecordHash);
    if (
      JSON.stringify(value) !== JSON.stringify(record.content) ||
      value.previousRecordHash !== (previous ? hash(previous) : 'GENESIS') ||
      (previous && value.previousAuditHead !== previous.content.headHash) ||
      !verify(
        null,
        Buffer.from(JSON.stringify(value)),
        publicKey,
        Buffer.from(record.signature, 'base64'),
      )
    )
      throw new Error('Witness signature or continuity failed');
    previous = record;
  }
  return {
    verified: true,
    records: records.length,
    lastRecordHash: previous ? hash(previous) : 'GENESIS',
    auditHead: previous?.content.headHash ?? 'GENESIS',
  };
}
