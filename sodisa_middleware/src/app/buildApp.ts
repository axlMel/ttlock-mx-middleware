import { randomUUID } from 'node:crypto';
import { describeError } from '../common';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type Redis from 'ioredis';
import { PgDeviceDirectory, PgRoutePlanRepository, type SqlClient } from '../catalog';
import { ConfigError, redactConfig, type AppConfig } from '../config';
import { createAssignmentDetector, createChainReader } from '../detectors';
import { createAuditLog, createCommandGateway } from '../gateway';
import { createOrchestrator, type Logger, type Orchestrator, type Scheduler } from '../orchestrator';
import { RedisCatalogCacheStore, RedisChainCursorStore, RedisRouteStateStore, type RouteStateStore } from '../persistence';
import type { App, AppFactories, PgPool } from './types';

export async function ensureAuditDirectory(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `.write-check-${randomUUID()}`);
    const file = await open(path, 'wx');
    try { await file.writeFile(''); }
    finally { await file.close(); await unlink(path); }
  } catch { throw new ConfigError(['AUDIT_LOG_DIR: no se pudo crear o escribir en el directorio.']); }
}

export function buildApp(config: AppConfig, logger: Logger, factories: AppFactories): App {
  let pool: PgPool | null = null;
  let stateRedis: Redis | null = null;
  let queueRedis: Redis | null = null;
  let scheduler: Scheduler | null = null;
  let orchestrator: Orchestrator | null = null;
  let routeStates: RouteStateStore | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let started = false;
  let startPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  const now = (): string => new Date(factories.now()).toISOString();
  const log = (event: string, fields: Record<string, unknown> = {}): void => logger.info(event, { timestamp: now(), ...fields });
  const closeRedis = async (redis: Redis | null): Promise<void> => {
    if (!redis) return;
    if (redis.status === 'connecting' || redis.status === 'reconnecting' || redis.status === 'wait') {
      redis.disconnect();
      return;
    }
    try { await redis.quit(); }
    catch { redis.disconnect(); }
  };
  const closeConnections = async (): Promise<boolean> => {
    let success = true;
    const queue = queueRedis; queueRedis = null;
    const state = stateRedis; stateRedis = null;
    const pg = pool; pool = null;
    for (const [stage, close] of [
      ['queue_redis', () => closeRedis(queue)],
      ['state_redis', () => closeRedis(state)],
      ['postgres', () => pg?.end() ?? Promise.resolve()],
    ] as const) {
      try { await close(); }
      catch { success = false; logger.error('shutdown_close_failed', { timestamp: now(), stage, reason: 'No se pudo cerrar el recurso.' }); }
    }
    return success;
  };
  const checkRedisConfig = async (redis: Redis): Promise<void> => {
    for (const [key, expected] of [['appendonly', 'yes'], ['maxmemory-policy', 'noeviction']] as const) {
      try {
        const result = await redis.config('GET', key) as string[];
        if (result[1] !== expected) logger.warn('redis_config_warning', { timestamp: now(), key,
          reason: `Redis ${key} debe ser ${expected}.` });
      } catch {
        log('redis_config_unavailable', { key, reason: 'Redis no permite consultar CONFIG GET.' });
      }
    }
  };
  const recordHeartbeat = async (): Promise<void> => {
    if (!routeStates) return;
    try {
      const counts: Record<string, number> = {};
      for (const state of await routeStates.list()) counts[state.fsmState] = (counts[state.fsmState] ?? 0) + 1;
      log('heartbeat', { dryRun: config.dryRun, states: counts });
    } catch { logger.error('heartbeat_failed', { timestamp: now(), reason: 'No se pudieron contar las rutas.' }); }
  };
  return {
    start(): Promise<void> {
      if (startPromise) return startPromise;
      startPromise = (async () => {
        log('startup_config', { config: redactConfig(config) });
        await ensureAuditDirectory(config.auditLogDir);
        let stage = 'PostgreSQL';
        try {
          pool = factories.createPool(config);
          await pool.query('SELECT 1');
          log('postgres_ready');
          stage = 'Redis';
          stateRedis = factories.createRedis(config, 'state');
          queueRedis = factories.createRedis(config, 'queue');
          await stateRedis.ping();
          await queueRedis.ping();
          log('redis_ready');
          await checkRedisConfig(stateRedis);
          stage = 'construcción de dependencias';
          const sql: SqlClient = { query: async (text, values) => ({ rows: (await pool!.query(text, values)).rows }) };
          routeStates = new RedisRouteStateStore(stateRedis);
          const cursors = new RedisChainCursorStore(stateRedis);
          const cache = new RedisCatalogCacheStore(stateRedis);
          const assignments = createAssignmentDetector(sql, { assignmentTz: config.assignmentTz });
          const chains = createChainReader(sql, { assignmentTz: config.assignmentTz,
            chainBatchLimit: config.chainBatchLimit, chainOverlapMs: config.chainOverlapMs,
            partitionRefreshMs: config.partitionRefreshMs, now: factories.now,
            onAlert: (alert) => logger.warn('chain_alert', { timestamp: now(), ...alert }) });
          const devices = new PgDeviceDirectory(sql);
          const plans = new PgRoutePlanRepository(sql, cache, { revalidateMs: config.catalogRevalidateMs,
            now: () => new Date(factories.now()), onNotice: (message) => logger.warn('catalog_notice', { timestamp: now(), message }) });
          const audit = createAuditLog(config.auditLogDir, { now: factories.now });
          const gateway = createCommandGateway(audit, { apiUrl: config.commandApiUrl, apiKey: config.apiKey,
            timeoutMs: config.commandApiTimeoutMs, dryRun: config.dryRun, now: factories.now });
          scheduler = factories.createScheduler(config, queueRedis);
          orchestrator = createOrchestrator({ detectors: { assignments, chains }, catalog: { devices, plans },
            gateway, routeStates, cursors, scheduler, logger }, { enabledCompanies: config.enabledCompanies,
            pollIntervalMsRoutes: config.pollIntervalMsRoutes,
            pollIntervalMsAck: config.pollIntervalMsAck, ackRetryBackoffMs: config.ackRetryBackoffMs,
            ackMaxRetries: config.ackMaxRetries, ackResendEnabled: config.ackResendEnabled,
            dryRun: config.dryRun, now: factories.now });
          if (config.dryRun) logger.warn('shadow_mode_active', { timestamp: now(), reason: 'Modo sombra activo.' });
          stage = 'orquestador';
          await orchestrator.start();
          started = true;
          heartbeat = setInterval(() => { void recordHeartbeat(); }, 60_000);
          log('startup_complete');
        } catch (error) {
          const { errorName, errorCode } = describeError(error);
          logger.error('startup_failed', { timestamp: now(), stage, reason: `Falló el arranque en ${stage}.`,
            errorName, ...(errorCode === undefined ? {} : { errorCode }) });
          if (scheduler && !started) {
            try { await scheduler.close(); }
            catch { logger.error('scheduler_close_failed', { timestamp: now(), reason: 'No se pudo cerrar el Scheduler.' }); }
            scheduler = null;
          }
          await closeConnections();
          throw error;
        }
      })();
      return startPromise;
    },
    shutdown(reason: string): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        try { await startPromise; } catch { /* El arranque ya limpió sus recursos. */ }
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        let success = true;
        if (started && orchestrator) {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([orchestrator.stop(), new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Tiempo de cierre agotado.')), 25_000);
            })]);
          } catch { success = false; logger.error('orchestrator_stop_failed', { timestamp: now(), reason: 'El orquestador no cerró en 25 s.' }); }
          finally { if (timer) clearTimeout(timer); }
        }
        if (!await closeConnections()) success = false;
        log('shutdown_complete', { reason });
        if (!success) throw new Error('El apagado no terminó correctamente.');
      })();
      return shutdownPromise;
    },
  };
}
