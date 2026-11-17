export function decodeFrame(raw: Buffer): string {
  return raw.toString('latin1').replace(/[\s]+$/u, '');
}
