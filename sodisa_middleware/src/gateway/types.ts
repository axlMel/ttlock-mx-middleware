export interface GatewayRequest {
  assignmentId: number; deviceId: number; unitId: number; apiCompanyId: number;
  stepSeq: number; transmissionSeq: number; idempotencyKey: string; command: string;
}
export type GatewayResult =
  | { kind: 'ACCEPTED'; httpStatus: 200; apiCommandId: string | null; apiStatus: string }
  | { kind: 'DRY_RUN' }
  | { kind: 'UNAVAILABLE'; httpStatus: 503 }
  | { kind: 'DEFINITIVE_ERROR'; httpStatus: number; reason: string }
  | { kind: 'UNCERTAIN'; cause: 'timeout' | 'network' | 'server_error' | 'invalid_response' };
export interface CommandGateway { send(req: GatewayRequest): Promise<GatewayResult> }
export interface AuditRecord extends GatewayRequest {
  ts: string; phase: 'INTENT' | 'RESULT';
  resultKind?: GatewayResult['kind']; httpStatus?: number;
  apiCommandId?: string | null; apiStatus?: string; reason?: string; cause?: string;
  durationMs?: number; dryRun: boolean;
}
export interface CommandAuditLog { append(record: AuditRecord): Promise<void> }
export interface GatewayOptions {
  apiUrl: string; apiKey: string; timeoutMs: number; dryRun: boolean;
  fetch?: typeof fetch; now?: () => number;
}
