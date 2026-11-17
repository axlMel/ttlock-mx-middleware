export function serialFor(stepSeq: number): string {
  if (!Number.isInteger(stepSeq) || stepSeq < 0 || stepSeq > 0xffff) throw new Error(`Paso fuera de rango: ${stepSeq}.`);
  return stepSeq.toString(16).toUpperCase().padStart(4, '0');
}
