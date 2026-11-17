export function toMicros(timestamp: string): bigint {
  const match = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?$/.exec(timestamp);
  if (!match) throw new Error(`Fecha de trama inválida: ${timestamp}.`);
  const millis = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  if (!Number.isFinite(millis)) throw new Error(`Fecha de trama inválida: ${timestamp}.`);
  return BigInt(millis) * 1000n + BigInt((match[7] ?? '').padEnd(6, '0'));
}
