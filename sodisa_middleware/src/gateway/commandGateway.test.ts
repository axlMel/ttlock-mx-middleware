import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidCommandInputError } from '../protocol';
import { createAuditLog, createCommandGateway, AuditUnavailableError, type AuditRecord, type GatewayRequest } from './index';
import { classify } from './classify';

const req: GatewayRequest = { assignmentId: 42, deviceId: 70177, unitId: 224979, apiCompanyId: 2,
  stepSeq: 1, transmissionSeq: 1, idempotencyKey: 'route-42-step-1', command: 'AT+GTGEO=gv300w,0,0,0.000000,0.000000,50,30,0,0,0,0,0,0,,,0,FFFF$' };
const accepted = JSON.parse(readFileSync(join(__dirname, '__fixtures__/accepted.json'), 'utf8')) as Record<string, unknown>;
const options = { apiUrl: 'https://example.test/api/v1/commands/send', apiKey: 'SECRET_SENTINEL_987', timeoutMs: 1000, dryRun: false };

test.each([
  [200, JSON.stringify(accepted), { kind: 'ACCEPTED', httpStatus: 200, apiCommandId: 'b54a0fa7-7581-416b-91b6-3fe8b75beda0', apiStatus: 'SENT_UNCONFIRMED' }],
  [200, '{', { kind: 'UNCERTAIN', cause: 'invalid_response' }],
  [200, '{}', { kind: 'UNCERTAIN', cause: 'invalid_response' }],
  [200, '{"status":""}', { kind: 'UNCERTAIN', cause: 'invalid_response' }],
  [200, '{"status":"   "}', { kind: 'UNCERTAIN', cause: 'invalid_response' }],
  [200, '{"status":42}', { kind: 'UNCERTAIN', cause: 'invalid_response' }],
  [200, '{"status":"OUTCOME_UNKNOWN","commandId":123}', { kind: 'ACCEPTED', httpStatus: 200, apiCommandId: '123', apiStatus: 'OUTCOME_UNKNOWN' }],
  [200, '{"status":"SENT_UNCONFIRMED","commandId":{}}', { kind: 'ACCEPTED', httpStatus: 200, apiCommandId: null, apiStatus: 'SENT_UNCONFIRMED' }],
  [503, '', { kind: 'UNAVAILABLE', httpStatus: 503 }],
  [302, '', { kind: 'DEFINITIVE_ERROR', httpStatus: 302, reason: 'Redirección no permitida.' }],
  [500, '', { kind: 'UNCERTAIN', cause: 'server_error' }],
  [401, 'Clave inválida', { kind: 'DEFINITIVE_ERROR', httpStatus: 401, reason: 'HTTP 401: Clave inválida' }],
  [403, '', { kind: 'DEFINITIVE_ERROR', httpStatus: 403, reason: 'HTTP 403: ' }],
  [404, '', { kind: 'DEFINITIVE_ERROR', httpStatus: 404, reason: 'HTTP 404: ' }],
  [409, '', { kind: 'DEFINITIVE_ERROR', httpStatus: 409, reason: 'HTTP 409: ' }],
  [422, '', { kind: 'DEFINITIVE_ERROR', httpStatus: 422, reason: 'HTTP 422: ' }],
  [418, '', { kind: 'DEFINITIVE_ERROR', httpStatus: 418, reason: 'HTTP 418: ' }],
] as const)('clasifica HTTP %s con cuerpo %s', (status, body, expected) => {
  expect(classify(status, body)).toEqual(expected);
});

test('envía petición exacta entre INTENT y RESULT', async () => {
  const events: string[] = [];
  const records: AuditRecord[] = [];
  const fetcher = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    events.push('fetch');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', 'X-API-Key': options.apiKey, 'Idempotency-Key': req.idempotencyKey });
    expect(JSON.parse(String(init?.body))).toEqual({ companyId: 2, unitId: '224979', comando: req.command });
    return new Response(JSON.stringify(accepted), { status: 200 });
  });
  const gateway = createCommandGateway({ append: async (record) => { events.push(record.phase); records.push(record); } }, { ...options, fetch: fetcher });
  expect(await gateway.send(req)).toMatchObject({ kind: 'ACCEPTED', apiStatus: 'SENT_UNCONFIRMED' });
  expect(fetcher).toHaveBeenCalledWith(options.apiUrl, expect.any(Object));
  expect(events).toEqual(['INTENT', 'fetch', 'RESULT']);
  expect(records.map((record) => [record.idempotencyKey, record.command])).toEqual([[req.idempotencyKey, req.command], [req.idempotencyKey, req.command]]);
  expect(records[1]).toMatchObject({ assignmentId: 42, deviceId: 70177, resultKind: 'ACCEPTED', httpStatus: 200 });
});

test('rechaza URL no HTTPS y comando no ASCII antes de auditar', async () => {
  expect(() => createCommandGateway({ append: jest.fn() }, { ...options, apiUrl: 'http://example.test' })).toThrow('HTTPS');
  const audit = { append: jest.fn() };
  const fetcher = jest.fn();
  const gateway = createCommandGateway(audit, { ...options, fetch: fetcher });
  await expect(gateway.send({ ...req, command: 'AT+GTGEO=á$' })).rejects.toBeInstanceOf(InvalidCommandInputError);
  expect(audit.append).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

test('modo sombra audita dos fases sin red', async () => {
  const records: AuditRecord[] = [];
  const fetcher = jest.fn();
  const gateway = createCommandGateway({ append: async (record) => { records.push(record); } }, { ...options, dryRun: true, fetch: fetcher });
  expect(await gateway.send(req)).toEqual({ kind: 'DRY_RUN' });
  expect(records.map((record) => [record.phase, record.dryRun])).toEqual([['INTENT', true], ['RESULT', true]]);
  expect(fetcher).not.toHaveBeenCalled();
});

test('fallo de INTENT impide fetch; fallo de RESULT conserva resultado', async () => {
  const fetcher = jest.fn(async () => new Response(JSON.stringify(accepted), { status: 200 }));
  const first = createCommandGateway({ append: async () => { throw new Error(options.apiKey); } }, { ...options, fetch: fetcher });
  await expect(first.send(req)).rejects.toBeInstanceOf(AuditUnavailableError);
  expect(fetcher).not.toHaveBeenCalled();
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const second = createCommandGateway({ append: async (record) => { if (record.phase === 'RESULT') throw new Error(options.apiKey); } }, { ...options, fetch: fetcher });
  expect(await second.send(req)).toMatchObject({ kind: 'ACCEPTED' });
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(log.mock.calls)).not.toContain(options.apiKey);
  log.mockRestore();
});

test('timeout durante lectura del cuerpo y error de red son inciertos', async () => {
  const audit = { append: async () => undefined };
  const stalled = jest.fn(async () => ({ status: 200, text: () => new Promise<string>(() => undefined) }) as Response);
  const timed = createCommandGateway(audit, { ...options, timeoutMs: 5, fetch: stalled });
  expect(await timed.send(req)).toEqual({ kind: 'UNCERTAIN', cause: 'timeout' });
  const failed = createCommandGateway(audit, { ...options, fetch: jest.fn(async () => { throw new Error(options.apiKey); }) });
  expect(await failed.send(req)).toEqual({ kind: 'UNCERTAIN', cause: 'network' });
});

test('auditoría JSONL usa día UTC, serializa escrituras y omite la API key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-audit-'));
  try {
    let now = Date.parse('2026-11-17T23:59:59.000Z');
    const audit = createAuditLog(dir, { now: () => now });
    const fetcher = jest.fn(async () => new Response('Clave ' + options.apiKey, { status: 401 }));
    const gateway = createCommandGateway(audit, { ...options, fetch: fetcher, now: () => now });
    expect(await gateway.send(req)).toMatchObject({ kind: 'DEFINITIVE_ERROR', reason: 'HTTP 401: Clave [REDACTED]' });
    now = Date.parse('2026-11-18T00:00:01.000Z');
    await gateway.send(req);
    const files = await readdir(dir);
    expect(files.sort()).toEqual(['audit-2026-11-17.jsonl', 'audit-2026-11-18.jsonl']);
    for (const name of files) {
      const content = await readFile(join(dir, name), 'utf8');
      expect(content).not.toContain(options.apiKey);
      expect(content.trim().split('\n').map((line) => JSON.parse(line).phase)).toEqual(['INTENT', 'RESULT']);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
