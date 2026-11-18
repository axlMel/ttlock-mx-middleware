import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { loadConfig, ConfigError } from '../config';
import { createChainReader } from '../detectors';
import { createOrchestrator, type Logger, type Orchestrator } from '../orchestrator';
import { buildApp, ensureAuditDirectory } from './buildApp';
import { realFactories } from './factories';
import type { AppFactories } from './types';

jest.mock('../orchestrator', () => {
  const actual = jest.requireActual('../orchestrator');
  return { ...actual, createOrchestrator: jest.fn() };
});
jest.mock('../detectors', () => {
  const actual = jest.requireActual('../detectors');
  return { ...actual, createChainReader: jest.fn(actual.createChainReader) };
});

const env = { ENABLED_COMPANIES: '364:2', COMMAND_API_URL: 'https://api.example.test/send',
  REDIS_URL: 'redis://:<valor-redis>@127.0.0.1:6379', COMMAND_API_KEY: '<valor-api>',
  DATABASE_URL: 'postgres://u:<valor-db>@host/db', COMMAND_DRY_RUN: 'true' };
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gtlock-app-'));
  jest.clearAllMocks();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function fixture() {
  const trace: string[] = [];
  const logger: Logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const config = loadConfig({ ...env, AUDIT_LOG_DIR: directory }, () => { throw Object.assign(new Error(), { code: 'ENOENT' }); });
  const pool = { query: jest.fn(async (sql: string) => { trace.push(`pg:${sql}`); return { rows: [] }; }),
    end: jest.fn(async () => { trace.push('pg:close'); }) } as unknown as Pool;
  const makeRedis = (role: string) => ({
    ping: jest.fn(async () => { trace.push(`${role}:ping`); return 'PONG'; }),
    config: jest.fn(async (_command: string, key: string) => [key, key === 'appendonly' ? 'yes' : 'noeviction']),
    quit: jest.fn(async () => { trace.push(`${role}:close`); return 'OK'; }),
    disconnect: jest.fn(),
    scan: jest.fn(async () => ['0', []]),
    get: jest.fn(async () => null),
  }) as unknown as Redis;
  const stateRedis = makeRedis('state');
  const queueRedis = makeRedis('queue');
  const scheduler = { schedule: jest.fn(async () => undefined), cancel: jest.fn(async () => undefined),
    onTask: jest.fn(), close: jest.fn(async () => { trace.push('scheduler:close'); }) };
  const orchestrator: Orchestrator = { start: jest.fn(async () => { trace.push('orchestrator:start'); }),
    stop: jest.fn(async () => { trace.push('orchestrator:stop'); await scheduler.close(); }) };
  jest.mocked(createOrchestrator).mockReturnValue(orchestrator);
  const factories: AppFactories = {
    createPool: jest.fn(() => { trace.push('pg:create'); return pool; }),
    createRedis: jest.fn((_config, role) => { trace.push(`${role}:create`); return role === 'state' ? stateRedis : queueRedis; }),
    createScheduler: jest.fn(() => { trace.push('scheduler:create'); return scheduler; }), now: () => Date.parse('2026-11-17T12:00:00Z'),
  };
  return { trace, logger, config, pool, stateRedis, queueRedis, scheduler, orchestrator, factories };
}

test('crea y comprueba el directorio antes de abrir conexiones', async () => {
  const badPath = join(directory, 'file');
  await writeFile(badPath, 'x');
  await expect(ensureAuditDirectory(badPath)).rejects.toBeInstanceOf(ConfigError);
  const h = fixture();
  h.config.auditLogDir = badPath;
  await expect(buildApp(h.config, h.logger, h.factories).start()).rejects.toBeInstanceOf(ConfigError);
  expect(h.factories.createPool).not.toHaveBeenCalled();
});

test('arranca en orden, cablea el mismo dryRun y las alertas, y oculta secretos', async () => {
  const h = fixture();
  const app = buildApp(h.config, h.logger, h.factories);
  await app.start();
  expect(h.trace).toEqual(['pg:create', 'pg:SELECT 1', 'state:create', 'queue:create',
    'state:ping', 'queue:ping', 'scheduler:create', 'orchestrator:start']);
  expect(h.factories.createRedis).toHaveBeenNthCalledWith(2, h.config, 'queue');
  const [deps, opts] = jest.mocked(createOrchestrator).mock.calls[0];
  expect(opts.dryRun).toBe(true);
  expect(opts.enabledCompanies).toEqual(new Map([[364, 2]]));
  const result = await deps.gateway.send({ assignmentId: 42, deviceId: 9001, unitId: 81,
    apiCompanyId: 2, stepSeq: 0, transmissionSeq: 1, idempotencyKey: '42-0-1', command: 'AT+GTGEO=TEST$' });
  expect(result.kind).toBe('DRY_RUN');
  const readerOptions = jest.mocked(createChainReader).mock.calls[0][1];
  readerOptions.onAlert?.({ code: 'PARTITION_UNREADABLE', partition: '202645', message: 'Sin permiso.' });
  expect(h.logger.warn).toHaveBeenCalledWith('chain_alert', expect.objectContaining({ code: 'PARTITION_UNREADABLE' }));
  expect(h.logger.warn).toHaveBeenCalledWith('shadow_mode_active', expect.any(Object));
  const logs = JSON.stringify([jest.mocked(h.logger.info).mock.calls, jest.mocked(h.logger.warn).mock.calls]);
  expect(logs).not.toContain('<valor-api>');
  expect(logs).not.toContain('<valor-db>');
  expect(logs).not.toContain('<valor-redis>');
  expect(logs).not.toContain(h.config.redisUrl);
  await app.shutdown('test');
  expect(h.trace.slice(-5)).toEqual(['orchestrator:stop', 'scheduler:close', 'queue:close', 'state:close', 'pg:close']);
  expect(h.scheduler.close).toHaveBeenCalledTimes(1);
});

test('un fallo de PostgreSQL o Redis impide arrancar el orquestador y cierra recursos', async () => {
  const pg = fixture();
  (pg.pool.query as jest.Mock).mockRejectedValueOnce(new Error('<valor-db>'));
  await expect(buildApp(pg.config, pg.logger, pg.factories).start()).rejects.toThrow();
  expect(createOrchestrator).not.toHaveBeenCalled();
  expect(pg.trace).toContain('pg:close');
  expect(pg.logger.error).toHaveBeenCalledWith('startup_failed', expect.objectContaining({ stage: 'PostgreSQL' }));
  expect(JSON.stringify(jest.mocked(pg.logger.error).mock.calls)).not.toContain('<valor-db>');
  const redis = fixture();
  jest.mocked(redis.stateRedis.ping).mockRejectedValueOnce(new Error('offline'));
  await expect(buildApp(redis.config, redis.logger, redis.factories).start()).rejects.toThrow();
  expect(createOrchestrator).not.toHaveBeenCalled();
  expect(redis.trace).toEqual(expect.arrayContaining(['queue:close', 'state:close', 'pg:close']));
  expect(redis.logger.error).toHaveBeenCalledWith('startup_failed', expect.objectContaining({ stage: 'Redis' }));
  expect(JSON.stringify(jest.mocked(redis.logger.error).mock.calls)).not.toContain(redis.config.redisUrl);
});

test('fallo al iniciar 002 cierra el Scheduler una vez y luego las conexiones', async () => {
  const h = fixture();
  jest.mocked(h.orchestrator.start).mockRejectedValueOnce(new Error('fallo'));
  await expect(buildApp(h.config, h.logger, h.factories).start()).rejects.toThrow();
  expect(h.orchestrator.stop).not.toHaveBeenCalled();
  expect(h.scheduler.close).toHaveBeenCalledTimes(1);
  expect(h.trace.slice(-4)).toEqual(['scheduler:close', 'queue:close', 'state:close', 'pg:close']);
});

test('CONFIG GET incorrecto avisa y prohibido permite continuar', async () => {
  const h = fixture();
  jest.mocked(h.stateRedis.config).mockResolvedValue(['appendonly', 'no']);
  const app = buildApp(h.config, h.logger, h.factories);
  await app.start();
  expect(h.logger.warn).toHaveBeenCalledWith('redis_config_warning', expect.objectContaining({ key: 'appendonly' }));
  await app.shutdown('test');
  const denied = fixture();
  jest.mocked(denied.stateRedis.config).mockRejectedValue(new Error('NOPERM'));
  const app2 = buildApp(denied.config, denied.logger, denied.factories);
  await app2.start();
  expect(denied.logger.info).toHaveBeenCalledWith('redis_config_unavailable', expect.any(Object));
  await app2.shutdown('test');
});

test('latido registra conteos y shutdown es idempotente', async () => {
  const h = fixture();
  jest.mocked(h.stateRedis.scan).mockResolvedValue(['0', ['route:42']]);
  jest.mocked(h.stateRedis.get).mockResolvedValue(JSON.stringify({ assignmentId: 42, fsmState: 'AWAITING_ACK' }));
  let tick: (() => void) | undefined;
  const interval = jest.spyOn(global, 'setInterval').mockImplementation((handler) => {
    tick = handler as () => void;
    return {} as NodeJS.Timeout;
  });
  const clear = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);
  try {
    const app = buildApp(h.config, h.logger, h.factories);
    await app.start();
    tick?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.logger.info).toHaveBeenCalledWith('heartbeat', expect.objectContaining({ dryRun: true,
      states: { AWAITING_ACK: 1 } }));
    await app.shutdown('SIGTERM');
    await app.shutdown('SIGINT');
    expect(h.orchestrator.stop).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalled();
  } finally { interval.mockRestore(); clear.mockRestore(); }
});

test('límite de 25 s continúa el cierre de conexiones y reporta fallo', async () => {
  const h = fixture();
  const app = buildApp(h.config, h.logger, h.factories);
  await app.start();
  jest.mocked(h.orchestrator.stop).mockReturnValueOnce(new Promise<void>(() => undefined));
  const original = global.setTimeout;
  const timeout = jest.spyOn(global, 'setTimeout').mockImplementation(((handler: () => void, delay: number) => {
    if (delay === 25_000) { queueMicrotask(handler); return {} as NodeJS.Timeout; }
    return original(handler, delay);
  }) as typeof setTimeout);
  try {
    await expect(app.shutdown('SIGTERM')).rejects.toThrow('El apagado no terminó correctamente.');
    expect(h.logger.error).toHaveBeenCalledWith('orchestrator_stop_failed', expect.any(Object));
    expect(h.trace.slice(-3)).toEqual(['queue:close', 'state:close', 'pg:close']);
  } finally { timeout.mockRestore(); }
});

test('fábricas reales configuran pool de tres conexiones y Redis de cola sin reintentos de petición', async () => {
  const h = fixture();
  const pool = realFactories.createPool(h.config) as Pool;
  expect(pool.options.max).toBe(3);
  expect(pool.options.statement_timeout).toBe(5000);
  expect(pool.options.application_name).toBe('gtlock-middleware');
  await pool.end();
  const queue = realFactories.createRedis(h.config, 'queue');
  expect(queue.options.maxRetriesPerRequest).toBeNull();
  queue.disconnect();
});
