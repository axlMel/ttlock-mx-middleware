import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import type { DeviceDirectory } from '../device-directory/types';
import type { ChainReportDetector, ChainReportRow, RouteAssignment, RouteDetector } from '../event-detectors/types';
import type { PollingCursorStore } from '../persistence/cursorStore';
import type { RouteStateStore } from '../persistence/routeStateStore';
import type { RouteState } from '../persistence/types';
import { buildGeoCommand } from '../protocol/command';
import { parseMessage } from '../protocol/parser';
import { GV300W_PROFILE, GV310LAU_PROFILE } from '../protocol/profiles';
import { sendGeoCommand } from '../protocol/transport';
import type { DeviceProfile, GeoParams, ParsedMessage } from '../protocol/types';
import { transition } from './fsm';
import type { DomainEvent, JobContext, JobData, JobName, JobQueue, OrchestratorConfig, OrchestratorLogger } from './types';

const QUEUE_NAME = 'site-lifecycle';
const REPORT_SOURCE = 'reporte_cadenas';
const WAITING_STATES = new Set(['AWAITING_ACK', 'IN_ZONE', 'AWAITING_EXIT_ALERT']);
const PROFILE_BY_MODEL = { GV300W: GV300W_PROFILE, GV310LAU: GV310LAU_PROFILE } as const;

export interface ProtocolPort {
  buildGeoCommand(profile: DeviceProfile, params: GeoParams): string;
  parseMessage(profile: DeviceProfile, raw: string): ParsedMessage;
  sendGeoCommand(host: string, port: number, command: string): Promise<void>;
}

export interface OrchestratorDependencies {
  routeDetector: RouteDetector;
  chainReportDetector: ChainReportDetector;
  deviceDirectory: DeviceDirectory;
  stateStore: RouteStateStore;
  cursorStore: PollingCursorStore;
  queue: JobQueue;
  protocol: ProtocolPort;
  logger: OrchestratorLogger;
  config: OrchestratorConfig;
  now?: () => string;
}

export class AckPendingError extends Error {
  constructor() {
    super('ACK pendiente; el comando volverá a enviarse.');
  }
}

export class SiteLifecycleOrchestrator {
  private readonly now: () => string;

  constructor(private readonly deps: OrchestratorDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async start(): Promise<void> {
    const cursor = await this.deps.cursorStore.get(REPORT_SOURCE);
    if (cursor === null) {
      await this.enqueuePoll('poll-reports', { bootstrap: true, previousDelayMs: this.deps.config.pollIntervalAckMs }, 0);
      return;
    }
    await this.ensurePoll('poll-routes', this.deps.config.pollIntervalRoutesMs);
    await this.ensurePoll('poll-reports', this.deps.config.pollIntervalAckMs);
  }

  async processJob(job: JobContext): Promise<void> {
    switch (job.name) {
      case 'poll-routes':
        await this.pollRoutes(job.data.previousDelayMs ?? this.deps.config.pollIntervalRoutesMs);
        return;
      case 'poll-reports':
        if (job.data.bootstrap) {
          await this.drainHistory(job.data.previousDelayMs ?? this.deps.config.pollIntervalAckMs);
        } else {
          await this.pollReports(job.data.previousDelayMs ?? this.deps.config.pollIntervalAckMs);
        }
        return;
      case 'send-command':
        await this.sendCommand(job);
    }
  }

  async onJobFailed(job: JobContext, error: Error): Promise<void> {
    if (job.name !== 'send-command' || job.attemptsMade < job.attempts) return;
    const { deviceId, siteIndex, routeId, batchNo } = job.data;
    if (deviceId === undefined || siteIndex === undefined || routeId === undefined) return;
    const state = await this.deps.stateStore.get(deviceId);
    if (!state || state.currentSiteIndex !== siteIndex || state.fsmState !== 'AWAITING_ACK') return;
    this.deps.logger.warn('Lote de reintentos de ACK agotado.', {
      timestamp: this.now(), deviceId, routeId, siteIndex,
      batchNo: batchNo ?? 0, retryCount: state.retryCount, error: error.message,
    });
    await this.persistTransition(state, { type: 'BATCH_EXHAUSTED' });
    await this.enqueueSend(state, (batchNo ?? 0) + 1, this.deps.config.ackRetryBackoffMs);
  }

  private async drainHistory(previousDelayMs: number): Promise<void> {
    const base = this.deps.config.pollIntervalAckMs;
    try {
      let count = 0;
      while (true) {
        const rows = await this.deps.chainReportDetector.getNewEvents();
        count += rows.length;
        if (rows.length === 0) break;
      }
      this.logPoll('poll-reports', count, base, true);
      await this.ensurePoll('poll-routes', this.deps.config.pollIntervalRoutesMs);
      await this.enqueuePoll('poll-reports', { previousDelayMs: base }, base);
    } catch (error) {
      const delay = this.nextDelay(previousDelayMs, base, false);
      this.deps.logger.error('Falló el drenaje inicial de reportes.', { timestamp: this.now(), error: String(error) });
      this.logPoll('poll-reports', 0, delay, false);
      await this.enqueuePoll('poll-reports', { bootstrap: true, previousDelayMs: delay }, delay);
    }
  }

  private async pollRoutes(previousDelayMs: number): Promise<void> {
    const base = this.deps.config.pollIntervalRoutesMs;
    let count = 0;
    let newDeviceCount = 0;
    let succeeded = false;
    try {
      const rows = await this.deps.routeDetector.getActiveRoutes();
      count = rows.length;
      const active = this.groupRoutes(rows);
      const stored = await this.deps.stateStore.list();
      const byDevice = new Map(stored.map((state) => [state.deviceId, state]));
      for (const [deviceId] of active) {
        try {
          let state = byDevice.get(deviceId) ?? null;
          if (state === null) {
            state = await this.persistTransition(null, { type: 'ASSIGNMENT_DETECTED', deviceId, routeId: deviceId });
            newDeviceCount += 1;
          }
          if (state && ['PENDING', 'CONFIGURING', 'AWAITING_ACK'].includes(state.fsmState)) {
            await this.ensureSend(state);
          }
        } catch (error) {
          this.deps.logger.error('Falló la conciliación de un dispositivo.', {
            timestamp: this.now(), deviceId, routeId: deviceId, error: String(error),
          });
        }
      }
      for (const state of stored) {
        if (!active.has(state.deviceId) && state.fsmState === 'COMPLETED') {
          await this.deps.stateStore.delete(state.deviceId);
          this.deps.logger.info('Estado de ruta completada eliminado.', this.trace(state));
        }
      }
      succeeded = true;
    } catch (error) {
      this.deps.logger.error('Falló la consulta de rutas.', { timestamp: this.now(), error: String(error) });
    }
    const delay = this.nextDelay(previousDelayMs, base, succeeded && newDeviceCount > 0);
    this.logPoll('poll-routes', count, delay, succeeded);
    await this.enqueuePoll('poll-routes', { previousDelayMs: delay }, delay);
  }

  private async pollReports(previousDelayMs: number): Promise<void> {
    const base = this.deps.config.pollIntervalAckMs;
    let count = 0;
    let succeeded = false;
    try {
      const rows = await this.deps.chainReportDetector.getNewEvents();
      count = rows.length;
      for (const row of rows) {
        try {
          await this.handleReport(row);
        } catch (error) {
          this.deps.logger.error('Falló el procesamiento de un reporte.', {
            timestamp: this.now(), deviceId: row.imei, error: String(error),
          });
        }
      }
      succeeded = true;
    } catch (error) {
      this.deps.logger.error('Falló la consulta de reportes.', { timestamp: this.now(), error: String(error) });
    }
    let delay = this.nextDelay(previousDelayMs, base, succeeded && count > 0);
    try {
      if ((await this.deps.stateStore.list()).some((state) => WAITING_STATES.has(state.fsmState))) delay = base;
    } catch (error) {
      this.deps.logger.error('Falló la lectura de estados para el polling.', { timestamp: this.now(), error: String(error) });
    }
    this.logPoll('poll-reports', count, delay, succeeded);
    await this.enqueuePoll('poll-reports', { previousDelayMs: delay }, delay);
  }

  private async handleReport(row: ChainReportRow): Promise<void> {
    const state = await this.deps.stateStore.get(row.imei);
    if (state === null) return;
    const device = await this.deps.deviceDirectory.getDeviceInfo(row.imei);
    const parsed = this.deps.protocol.parseMessage(PROFILE_BY_MODEL[device.model], row.raw);
    if (parsed.kind === 'unknown' || parsed.imei !== row.imei) return;
    if (parsed.kind === 'ack') {
      if (state.fsmState !== 'AWAITING_ACK') {
        this.logIgnored(state, 'ACK fuera de estado');
        return;
      }
      const siteCount = (await this.getSites(row.imei)).length;
      const next = await this.persistTransition(state, { type: 'ACK', siteCount });
      if (next !== state) await this.deps.queue.cancelPending('send-command', row.imei, state.currentSiteIndex);
      return;
    }
    if (parsed.geofenceId !== '0') {
      this.logIgnored(state, 'Geocerca ajena');
      return;
    }
    if (parsed.event === 'enter') {
      await this.persistTransition(state, { type: 'ZONE_ENTER' });
      return;
    }
    const siteCount = (await this.getSites(row.imei)).length;
    const next = await this.persistTransition(state, { type: 'ZONE_EXIT', siteCount });
    if (next !== state && (next?.fsmState === 'PENDING' || next?.fsmState === 'CONFIGURING')) {
      await this.ensureSend(next);
    }
  }

  private async sendCommand(job: JobContext): Promise<void> {
    const { deviceId, routeId, siteIndex } = job.data;
    if (deviceId === undefined || routeId === undefined || siteIndex === undefined) return;
    let state = await this.deps.stateStore.get(deviceId);
    if (!state || state.routeId !== routeId || state.currentSiteIndex !== siteIndex ||
        !['PENDING', 'CONFIGURING', 'AWAITING_ACK'].includes(state.fsmState)) return;
    const sites = await this.getSites(deviceId);
    if (sites.length === 0 || siteIndex > sites.length) {
      this.deps.logger.warn('El dispositivo ya no tiene una asignación vigente.', { ...this.trace(state), siteIndex });
      return;
    }
    const firstSend = state.fsmState !== 'AWAITING_ACK';
    if (state.fsmState === 'PENDING') {
      state = await this.persistTransition(state, { type: 'STEP_READY' });
      if (!state) return;
    }
    const device = await this.deps.deviceDirectory.getDeviceInfo(deviceId);
    const params: GeoParams = siteIndex === sites.length
      ? { lat: 0, lon: 0, radius: 50, mode: 0 }
      : { lat: sites[siteIndex].latitude, lon: sites[siteIndex].longitude,
          radius: sites[siteIndex].radius, mode: 3 };
    const command = this.deps.protocol.buildGeoCommand(PROFILE_BY_MODEL[device.model], params);
    await this.deps.protocol.sendGeoCommand(device.ip, device.port, command);
    const sentAt = this.now();
    const next = await this.persistTransition(state, { type: firstSend ? 'COMMAND_SENT' : 'COMMAND_RESENT', sentAt });
    this.deps.logger.info('Comando UDP enviado.', {
      ...this.trace(next ?? state), siteIndex, retryCount: next?.retryCount ?? state.retryCount,
      command, host: device.ip, port: device.port,
    });
    throw new AckPendingError();
  }

  private async persistTransition(state: RouteState | null, event: DomainEvent): Promise<RouteState | null> {
    const next = transition(state, event);
    if (next === state) {
      if (state) this.logIgnored(state, event.type);
      return state;
    }
    if (next === null) return null;
    await this.deps.stateStore.set(next.deviceId, next);
    this.deps.logger.info('Transición de estado.', {
      ...this.trace(next), previousState: state?.fsmState ?? null,
      nextState: next.fsmState, event: event.type, siteIndex: next.currentSiteIndex,
      retryCount: next.retryCount,
    });
    return next;
  }

  private async getSites(deviceId: string): Promise<RouteAssignment[]> {
    return (await this.deps.routeDetector.getActiveRoutes())
      .filter((row) => row.imei === deviceId)
      .sort((a, b) => a.order - b.order);
  }

  private groupRoutes(rows: RouteAssignment[]): Map<string, RouteAssignment[]> {
    const groups = new Map<string, RouteAssignment[]>();
    for (const row of rows) groups.set(row.imei, [...(groups.get(row.imei) ?? []), row]);
    for (const sites of groups.values()) sites.sort((a, b) => a.order - b.order);
    return groups;
  }

  private async ensureSend(state: RouteState): Promise<void> {
    if (await this.deps.queue.hasPending('send-command', state.deviceId, state.currentSiteIndex)) return;
    const batchNo = Math.floor((state.retryCount + 1) / (this.deps.config.ackMaxRetries + 1));
    await this.enqueueSend(state, batchNo, 0);
  }

  private async enqueueSend(state: RouteState, batchNo: number, delay: number): Promise<void> {
    await this.deps.queue.add('send-command', {
      deviceId: state.deviceId, routeId: state.routeId,
      siteIndex: state.currentSiteIndex, batchNo,
    }, {
      delay,
      jobId: `send-${state.deviceId}-${state.currentSiteIndex}-${batchNo}`,
      attempts: this.deps.config.ackMaxRetries + 1,
      backoff: { type: 'fixed', delay: this.deps.config.ackRetryBackoffMs },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  private async ensurePoll(name: 'poll-routes' | 'poll-reports', base: number): Promise<void> {
    if (!(await this.deps.queue.hasPending(name))) {
      await this.enqueuePoll(name, { previousDelayMs: base }, 0);
    }
  }

  private async enqueuePoll(name: 'poll-routes' | 'poll-reports', data: JobData, delay: number): Promise<void> {
    await this.deps.queue.add(name, data, { delay, jobId: `${name}-${randomUUID()}`, removeOnComplete: true });
  }

  private nextDelay(previous: number, base: number, hasNew: boolean): number {
    return hasNew ? base : Math.min(Math.max(previous, base) * 2, base * 5);
  }

  private logPoll(source: JobName, count: number, nextDelayMs: number, success: boolean): void {
    this.deps.logger.info('Ciclo de polling completado.', {
      timestamp: this.now(), source, count, nextDelayMs, success,
    });
  }

  private trace(state: RouteState): Record<string, unknown> {
    return { timestamp: this.now(), deviceId: state.deviceId, routeId: state.routeId };
  }

  private logIgnored(state: RouteState, reason: string): void {
    this.deps.logger.debug('Evento ignorado.', { ...this.trace(state), reason });
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const parse = (name: string, allowZero = false): number => {
    const raw = env[name];
    const value = Number(raw);
    if (raw === undefined || raw.trim() === '' || !Number.isSafeInteger(value) ||
        (allowZero ? value < 0 : value <= 0)) {
      throw new Error(`La variable ${name} debe ser un entero ${allowZero ? 'no negativo' : 'positivo'}.`);
    }
    return value;
  };
  return {
    pollIntervalRoutesMs: parse('POLL_INTERVAL_MS_ROUTES'),
    pollIntervalAckMs: parse('POLL_INTERVAL_MS_ACK'),
    ackMaxRetries: parse('ACK_MAX_RETRIES', true),
    ackRetryBackoffMs: parse('ACK_RETRY_BACKOFF_MS'),
  };
}

export async function startBullWorker(
  dependencies: Omit<OrchestratorDependencies, 'queue' | 'protocol' | 'logger' | 'config'> & {
    redisUrl: string;
    logger?: OrchestratorLogger;
    protocol?: ProtocolPort;
    config?: OrchestratorConfig;
  },
): Promise<{ close(): Promise<void>; orchestrator: SiteLifecycleOrchestrator }> {
  const connection = new Redis(dependencies.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<JobData>(QUEUE_NAME, { connection });
  const pendingJobs = async () => queue.getJobs(['waiting', 'delayed', 'active']);
  const adapter: JobQueue = {
    add: async (name, data, options) => { await queue.add(name, data, options); },
    hasPending: async (name, deviceId, siteIndex) =>
      (await pendingJobs()).some((job) => job.name === name &&
        (deviceId === undefined || job.data.deviceId === deviceId) &&
        (siteIndex === undefined || job.data.siteIndex === siteIndex)),
    cancelPending: async (name, deviceId, siteIndex) => {
      for (const job of await queue.getJobs(['waiting', 'delayed'])) {
        if (job.name === name && job.data.deviceId === deviceId && job.data.siteIndex === siteIndex) {
          await job.remove();
        }
      }
    },
  };
  const logger = dependencies.logger ?? console;
  const orchestrator = new SiteLifecycleOrchestrator({
    ...dependencies,
    queue: adapter,
    protocol: dependencies.protocol ?? { buildGeoCommand, parseMessage, sendGeoCommand },
    logger,
    config: dependencies.config ?? configFromEnv(),
  });
  const worker = new Worker<JobData>(QUEUE_NAME, async (job: Job<JobData>) => {
    await orchestrator.processJob({
      name: job.name as JobName,
      data: job.data,
      attemptsMade: job.attemptsMade,
      attempts: job.opts.attempts ?? 1,
    });
  }, { connection, concurrency: 4 });
  worker.on('failed', (job, error) => {
    if (!job) return;
    void orchestrator.onJobFailed({
      name: job.name as JobName,
      data: job.data,
      attemptsMade: job.attemptsMade,
      attempts: job.opts.attempts ?? 1,
    }, error).catch((failure) => {
      logger.error('Falló la programación del siguiente lote.', { timestamp: new Date().toISOString(), error: String(failure) });
    });
  });
  await orchestrator.start();
  return {
    orchestrator,
    close: async () => { await worker.close(); await queue.close(); connection.disconnect(); },
  };
}
