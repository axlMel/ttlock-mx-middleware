import type { GatewayResult } from './types';

export function classify(status: number, body: string): GatewayResult {
  if (status === 200) {
    let data: unknown;
    try { data = JSON.parse(body); } catch { return { kind: 'UNCERTAIN', cause: 'invalid_response' }; }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { kind: 'UNCERTAIN', cause: 'invalid_response' };
    const response = data as Record<string, unknown>;
    if (typeof response.status !== 'string' || response.status.trim().length === 0) return { kind: 'UNCERTAIN', cause: 'invalid_response' };
    const commandId = response.commandId;
    const apiCommandId = typeof commandId === 'string' ? commandId
      : typeof commandId === 'number' && Number.isFinite(commandId) ? String(commandId) : null;
    return { kind: 'ACCEPTED', httpStatus: 200, apiCommandId, apiStatus: response.status };
  }
  if (status === 503) return { kind: 'UNAVAILABLE', httpStatus: 503 };
  if (status >= 300 && status < 400) return { kind: 'DEFINITIVE_ERROR', httpStatus: status, reason: 'Redirección no permitida.' };
  if (status >= 400 && status < 500) return { kind: 'DEFINITIVE_ERROR', httpStatus: status, reason: `HTTP ${status}: ${body}` };
  return { kind: 'UNCERTAIN', cause: 'server_error' };
}
