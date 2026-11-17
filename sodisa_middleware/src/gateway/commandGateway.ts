import { InvalidCommandInputError } from '../protocol';
import { classify } from './classify';
import { AuditUnavailableError } from './errors';
import type { AuditRecord, CommandAuditLog, CommandGateway, GatewayOptions, GatewayRequest, GatewayResult } from './types';

const TIMEOUT = Symbol('timeout');

export function createCommandGateway(audit: CommandAuditLog, opts: GatewayOptions): CommandGateway {
  let url: URL;
  try { url = new URL(opts.apiUrl); } catch { throw new Error('La URL de la API de comandos no es válida.'); }
  if (url.protocol !== 'https:') throw new Error('La URL de la API de comandos debe usar HTTPS.');
  const fetcher = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const redact = (value: string): string => opts.apiKey ? value.replaceAll(opts.apiKey, '[REDACTED]') : value;
  const sanitize = (result: GatewayResult): GatewayResult => {
    if (result.kind === 'DEFINITIVE_ERROR') return { ...result, reason: redact(result.reason) };
    return result;
  };

  return {
    async send(req: GatewayRequest): Promise<GatewayResult> {
      if (typeof req.command !== 'string' || !/^[\x20-\x7E]+$/.test(req.command)) {
        throw new InvalidCommandInputError('command', req.command);
      }
      const started = now();
      const base = { ...req, command: redact(req.command), idempotencyKey: redact(req.idempotencyKey), dryRun: opts.dryRun };
      const intent: AuditRecord = { ...base, ts: new Date(started).toISOString(), phase: 'INTENT' };
      try { await audit.append(intent); } catch { throw new AuditUnavailableError(); }

      let result: GatewayResult;
      if (opts.dryRun) result = { kind: 'DRY_RUN' };
      else {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(TIMEOUT); }, opts.timeoutMs);
        });
        try {
          const body = JSON.stringify({ companyId: req.apiCompanyId, unitId: String(req.unitId), comando: req.command });
          const response = await Promise.race([
            (async () => {
              const reply = await fetcher(opts.apiUrl, { method: 'POST', redirect: 'manual', signal: controller.signal,
                headers: { 'Content-Type': 'application/json', 'X-API-Key': opts.apiKey, 'Idempotency-Key': req.idempotencyKey }, body });
              return { status: reply.status, body: reply.status === 200 || (reply.status >= 400 && reply.status < 500 && reply.status !== 503) ? await reply.text() : '' };
            })(), deadline,
          ]);
          result = sanitize(classify(response.status, response.body));
        } catch (error) {
          result = { kind: 'UNCERTAIN', cause: error === TIMEOUT || controller.signal.aborted ? 'timeout' : 'network' };
        } finally { if (timer) clearTimeout(timer); }
      }

      const details = result.kind === 'ACCEPTED'
        ? { httpStatus: result.httpStatus, apiCommandId: result.apiCommandId === null ? null : redact(result.apiCommandId), apiStatus: redact(result.apiStatus) }
        : result.kind === 'DEFINITIVE_ERROR' ? { httpStatus: result.httpStatus, reason: result.reason }
          : result.kind === 'UNAVAILABLE' ? { httpStatus: result.httpStatus }
            : result.kind === 'UNCERTAIN' ? { cause: result.cause } : {};
      const record: AuditRecord = { ...base, ...details, ts: new Date(now()).toISOString(), phase: 'RESULT',
        resultKind: result.kind, durationMs: now() - started };
      try { await audit.append(record); } catch { console.error('No se pudo registrar el resultado del comando en la auditoría.'); }
      return result;
    },
  };
}
