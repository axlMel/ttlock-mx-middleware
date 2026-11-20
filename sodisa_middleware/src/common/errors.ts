export interface ErrorDescription {
  errorName: string;
  errorCode?: string;
  errorMessage: string;
}

// Se redacta antes de truncar para no dejar una contraseña parcial en el log.
export function describeError(error: unknown): ErrorDescription {
  const record = error !== null && (typeof error === 'object' || typeof error === 'function')
    ? error as { code?: unknown; message?: unknown } : null;
  const errorName = error instanceof Error ? error.name : typeof error;
  const code = record?.code;
  let message: string;
  try { message = typeof record?.message === 'string' ? record.message : String(error); }
  catch { message = 'No se pudo describir el error.'; }
  const errorMessage = message.replace(/:\/\/[^/@\s]*:[^/@\s]*@/g, '://***@').slice(0, 200);
  return { errorName, ...(typeof code === 'string' || typeof code === 'number' ? { errorCode: String(code) } : {}), errorMessage };
}
