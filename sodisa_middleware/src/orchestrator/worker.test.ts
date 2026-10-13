import type Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import type { DeviceDirectory, DeviceDirectoryEntry } from '../device-directory/types';
import type { ChainReportDetector, ChainReportRow, RouteAssignment, RouteDetector } from '../event-detectors/types';
import { RedisPollingCursorStore } from '../persistence/cursorStore';
import { RedisRouteStateStore } from '../persistence/routeStateStore';
import type { RouteState } from '../persistence/types';
import type { ParsedMessage } from '../protocol/types';
import type { JobContext, JobData, JobName, JobOptions, JobQueue, OrchestratorLogger } from './types';
import { AckPendingError, SiteLifecycleOrchestrator, configFromEnv, type ProtocolPort } from './worker';

const A = '863457050476769';
const B = '868589060960328';
const site = (imei: string, order: number): RouteAssignment =>
  ({ imei, latitude: 19 + order, longitude: -99 - order, radius: 50, order });

interface PendingJob {
  name: JobName;
  data: JobData;
  options: JobOptions;
  attemptsMade: number;
}

class FakeQueue implements JobQueue {
  readonly jobs: PendingJob[] = [];
  orchestrator!: SiteLifecycleOrchestrator;

  async add(name: JobName, data: JobData, options: JobOptions = {}): Promise<void> {
    if (options.jobId && this.jobs.some((job) => job.options.jobId === options.jobId)) return;
    this.jobs.push({ name, data, options, attemptsMade: 0 });
  }

  async hasPending(name: JobName, deviceId?: string, siteIndex?: number): Promise<boolean> {
    return this.jobs.some((job) => job.name === name &&
      (deviceId === undefined || job.data.deviceId === deviceId) &&
      (siteIndex === undefined || job.data.siteIndex === siteIndex));
  }

  async cancelPending(name: JobName, deviceId: string, siteIndex: number): Promise<void> {
    for (let i = this.jobs.length - 1; i >= 0; i -= 1) {
      const job = this.jobs[i];
      if (job.name === name && job.data.deviceId === deviceId && job.data.siteIndex === siteIndex) {
        this.jobs.splice(i, 1);
      }
    }
  }

  async run(name: JobName, deviceId?: string): Promise<PendingJob> {
    const index = this.jobs.findIndex((job) => job.name === name &&
      (deviceId === undefined || job.data.deviceId === deviceId));
    if (index < 0) throw new Error(`No hay job ${name} para ejecutar.`);
    const [job] = this.jobs.splice(index, 1);
    const attempts = job.options.attempts ?? 1;
    const context: JobContext = { name: job.name, data: job.data, attemptsMade: job.attemptsMade, attempts };
    try {
      await this.orchestrator.processJob(context);
    } catch (error) {
      if (!(error instanceof AckPendingError)) throw error;
      if (job.attemptsMade + 1 < attempts) {
        this.jobs.push({ ...job, attemptsMade: job.attemptsMade + 1 });
      } else {
        await this.orchestrator.onJobFailed({ ...context, attemptsMade: attempts }, error);
      }
    }
    return job;
  }
}

describe('SiteLifecycleOrchestrator', () => {
  let redis: Redis;
  let stateStore: RedisRouteStateStore;
  let cursorStore: RedisPollingCursorStore;
  let queue: FakeQueue;
  let logger: jest.Mocked<OrchestratorLogger>;
  let protocol: ProtocolPort;
  let sent: string[];
  let routes: RouteAssignment[];
  let batches: ChainReportRow[][];
  let routeError = false;
  let reportError = false;
  let orchestrator: SiteLifecycleOrchestrator;

  const report = (imei: string, raw: string, id: number): ChainReportRow =>
    ({ idReport: String(id), imei, raw });
  const current = async (imei = A): Promise<RouteState> => {
    const state = await stateStore.get(imei);
    if (!state) throw new Error('Falta estado de prueba.');
    return state;
  };

  beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
    stateStore = new RedisRouteStateStore(redis);
    cursorStore = new RedisPollingCursorStore(redis);
    queue = new FakeQueue();
    routes = [site(A, 1), site(A, 2)];
    batches = [];
    sent = [];
    routeError = false;
    reportError = false;
    logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const routeDetector: RouteDetector = {
      getActiveRoutes: async () => {
        if (routeError) { routeError = false; throw new Error('BD de rutas no disponible'); }
        return routes;
      },
    };
    const chainReportDetector: ChainReportDetector = {
      getNewEvents: async () => {
        if (reportError) { reportError = false; throw new Error('BD de reportes no disponible'); }
        const rows = batches.shift() ?? [];
        if (rows.length > 0) await cursorStore.set('reporte_cadenas', rows.at(-1)!.idReport);
        return rows;
      },
    };
    const deviceDirectory: DeviceDirectory = {
      getDeviceInfo: async (imei): Promise<DeviceDirectoryEntry> => ({
        imei, model: imei === A ? 'GV300W' : 'GV310LAU', ip: imei === A ? '10.0.0.1' : '10.0.0.2', port: 55010,
      }),
    };
    protocol = {
      buildGeoCommand: (_profile, params) => `mode:${params.mode}:lat:${params.lat}`,
      parseMessage: (_profile, raw): ParsedMessage => {
        const [kind, imei] = raw.split(':');
        if (kind === 'ack') return { kind: 'ack', imei, raw };
        if (kind === 'enter' || kind === 'exit') {
          return { kind: 'zoneEvent', imei, geofenceId: '0', event: kind, raw };
        }
        return { kind: 'unknown', raw };
      },
      sendGeoCommand: async (host, port, command) => { sent.push(`${host}:${port}:${command}`); },
    };
    orchestrator = new SiteLifecycleOrchestrator({
      routeDetector, chainReportDetector, deviceDirectory, stateStore, cursorStore,
      queue, protocol, logger,
      config: { pollIntervalRoutesMs: 10, pollIntervalAckMs: 5, ackMaxRetries: 1, ackRetryBackoffMs: 7 },
      now: () => '2026-10-12T12:00:00.000Z',
    });
    queue.orchestrator = orchestrator;
  });

  afterEach(() => redis.disconnect());

  test('recorre dos sitios, acepta salida sin entrada y completa solo tras ACK del reset', async () => {
    await cursorStore.set('reporte_cadenas', '0');
    await orchestrator.start();
    await queue.run('poll-routes');
    expect((await current()).fsmState).toBe('PENDING');
    await queue.run('send-command', A);
    expect((await current()).fsmState).toBe('AWAITING_ACK');
    batches.push([report(A, `ack:${A}`, 1)]);
    await queue.run('poll-reports');
    expect((await current()).fsmState).toBe('IN_ZONE');
    expect(await queue.hasPending('send-command', A, 0)).toBe(false);
    batches.push([report(A, `enter:${A}`, 2)]);
    await queue.run('poll-reports');
    expect((await current()).fsmState).toBe('AWAITING_EXIT_ALERT');
    batches.push([report(A, `exit:${A}`, 3)]);
    await queue.run('poll-reports');
    expect((await current()).currentSiteIndex).toBe(1);
    await queue.run('send-command', A);
    batches.push([report(A, `ack:${A}`, 4), report(A, `exit:${A}`, 5)]);
    await queue.run('poll-reports');
    expect(await current()).toMatchObject({ fsmState: 'CONFIGURING', currentSiteIndex: 2, retryCount: 0 });
    await queue.run('send-command', A);
    expect(sent.at(-1)).toContain('mode:0');
    expect((await current()).fsmState).toBe('AWAITING_ACK');
    batches.push([report(A, `ack:${A}`, 6), report(A, `ack:${A}`, 7)]);
    await queue.run('poll-reports');
    expect((await current()).fsmState).toBe('COMPLETED');
    expect(sent.length).toBe(3);
    expect(logger.info.mock.calls.filter(([message]) => message === 'Comando UDP enviado.')).toHaveLength(3);
    for (const [message, fields] of logger.info.mock.calls) {
      if (message === 'Transición de estado.' || message === 'Comando UDP enviado.') {
        expect(fields).toEqual(expect.objectContaining({ timestamp: expect.any(String), deviceId: A, routeId: A }));
      }
    }
    expect(logger.debug).toHaveBeenCalledWith('Evento ignorado.', expect.objectContaining({ deviceId: A }));
  });

  test('reintenta por varios lotes sin fallo terminal y no bloquea otro equipo', async () => {
    routes.push(site(B, 1));
    await cursorStore.set('reporte_cadenas', '0');
    await orchestrator.start();
    await queue.run('poll-routes');
    await queue.run('send-command', A);
    await queue.run('send-command', A);
    expect(await current()).toMatchObject({ fsmState: 'AWAITING_ACK', currentSiteIndex: 0, retryCount: 1 });
    expect(queue.jobs.find((job) => job.name === 'send-command' && job.data.deviceId === A)?.data.batchNo).toBe(1);
    await queue.run('send-command', A);
    await queue.run('send-command', A);
    expect(await current()).toMatchObject({ fsmState: 'AWAITING_ACK', currentSiteIndex: 0, retryCount: 3 });
    expect(logger.warn.mock.calls.filter(([message]) => message === 'Lote de reintentos de ACK agotado.')).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith('Lote de reintentos de ACK agotado.',
      expect.objectContaining({ deviceId: A, routeId: A, retryCount: 3, batchNo: 1 }));
    await queue.run('send-command', B);
    batches.push([report(B, `ack:${B}`, 1)]);
    await queue.run('poll-reports');
    expect((await current(B)).fsmState).toBe('IN_ZONE');
    expect((await current(A)).fsmState).toBe('AWAITING_ACK');
    batches.push([report(A, `ack:${A}`, 2)]);
    await queue.run('poll-reports');
    expect((await current()).fsmState).toBe('IN_ZONE');
    expect(await queue.hasPending('send-command', A, 0)).toBe(false);
  });

  test('espacia polling, recupera intervalo base y continúa tras errores', async () => {
    routes = [];
    await cursorStore.set('reporte_cadenas', '0');
    await orchestrator.start();
    for (const delay of [20, 40, 50, 50]) {
      await queue.run('poll-routes');
      expect(queue.jobs.find((job) => job.name === 'poll-routes')?.options.delay).toBe(delay);
    }
    routes = [site(A, 1)];
    await queue.run('poll-routes');
    expect(queue.jobs.find((job) => job.name === 'poll-routes')?.options.delay).toBe(10);
    await queue.run('send-command', A);
    await queue.run('poll-reports');
    expect(queue.jobs.find((job) => job.name === 'poll-reports')?.options.delay).toBe(5);
    reportError = true;
    await queue.run('poll-reports');
    expect(queue.jobs.find((job) => job.name === 'poll-reports')?.options.delay).toBe(5);
    routeError = true;
    await queue.run('poll-routes');
    expect(queue.jobs.find((job) => job.name === 'poll-routes')?.options.delay).toBe(20);
    expect(logger.error).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Ciclo de polling completado.',
      expect.objectContaining({ source: 'poll-routes', nextDelayMs: 20 }));
  });

  test('drena reportes antiguos antes de crear rutas y reanuda sin duplicar cadenas', async () => {
    batches.push([report(A, `ack:${A}`, 1)], []);
    await orchestrator.start();
    expect(await queue.hasPending('poll-routes')).toBe(false);
    await queue.run('poll-reports');
    expect(await queue.hasPending('poll-routes')).toBe(true);
    await queue.run('poll-routes');
    expect((await current()).fsmState).toBe('PENDING');
    await queue.run('send-command', A);
    expect((await current()).fsmState).toBe('AWAITING_ACK');
    expect(await queue.hasPending('send-command', A, 0)).toBe(true);
    await orchestrator.start();
    await queue.run('poll-routes');
    expect(queue.jobs.filter((job) => job.name === 'send-command' && job.data.deviceId === A)).toHaveLength(1);
  });

  test('conserva COMPLETED vigente y lo elimina cuando desaparece la asignación', async () => {
    await cursorStore.set('reporte_cadenas', '0');
    await stateStore.set(A, {
      deviceId: A, routeId: A, currentSiteIndex: 2, fsmState: 'COMPLETED',
      lastCommandSentAt: '2026-10-12T12:00:00.000Z', retryCount: 0,
    });
    await orchestrator.start();
    await queue.run('poll-routes');
    expect((await current()).fsmState).toBe('COMPLETED');
    routes = [];
    await queue.run('poll-routes');
    await expect(stateStore.get(A)).resolves.toBeNull();
  });
});

test('lee los intervalos y reintentos desde el entorno y rechaza valores ausentes', () => {
  expect(configFromEnv({
    POLL_INTERVAL_MS_ROUTES: '100', POLL_INTERVAL_MS_ACK: '20',
    ACK_MAX_RETRIES: '0', ACK_RETRY_BACKOFF_MS: '50',
  })).toEqual({ pollIntervalRoutesMs: 100, pollIntervalAckMs: 20,
    ackMaxRetries: 0, ackRetryBackoffMs: 50 });
  expect(() => configFromEnv({ POLL_INTERVAL_MS_ROUTES: '100' }))
    .toThrow('POLL_INTERVAL_MS_ACK');
});

test('libera worker, cola y Redis si falla el arranque de BullMQ', async () => {
  jest.resetModules();
  const closeWorker = jest.fn(async () => undefined);
  const closeQueue = jest.fn(async () => undefined);
  const disconnect = jest.fn();
  jest.doMock('bullmq', () => ({
    Queue: jest.fn().mockImplementation(() => ({ close: closeQueue })),
    Worker: jest.fn().mockImplementation(() => ({ close: closeWorker, on: jest.fn() })),
  }));
  jest.doMock('ioredis', () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({ disconnect })),
  }));
  const isolated = await import('./worker');
  jest.spyOn(isolated.SiteLifecycleOrchestrator.prototype, 'start')
    .mockRejectedValueOnce(new Error('fallo de arranque simulado'));
  await expect(isolated.startBullWorker({
    redisUrl: 'redis://fake',
    routeDetector: { getActiveRoutes: async () => [] },
    chainReportDetector: { getNewEvents: async () => [] },
    deviceDirectory: { getDeviceInfo: async (imei) => ({ imei, model: 'GV300W', ip: '127.0.0.1', port: 55010 }) },
    stateStore: { get: async () => null, set: async () => undefined, delete: async () => undefined, list: async () => [] },
    cursorStore: { get: async () => null, set: async () => undefined },
    config: { pollIntervalRoutesMs: 10, pollIntervalAckMs: 10, ackMaxRetries: 1, ackRetryBackoffMs: 10 },
  })).rejects.toThrow('fallo de arranque simulado');
  expect(closeWorker).toHaveBeenCalledTimes(1);
  expect(closeQueue).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(1);
  jest.dontMock('bullmq');
  jest.dontMock('ioredis');
});
