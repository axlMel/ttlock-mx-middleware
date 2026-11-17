import type Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import type { AssignmentRow, ChainFrame } from '../detectors';
import type { RoutePlan } from '../catalog';
import { AuditUnavailableError, type GatewayRequest, type GatewayResult } from '../gateway';
import { RedisChainCursorStore, RedisRouteStateStore, type RouteState } from '../persistence';
import { AssignmentCycle } from './assignmentCycle';
import { ChainPoller } from './chainPoller';
import { KeyedMutex } from './keyedMutex';
import { createOrchestrator } from './orchestrator';
import { FakeScheduler } from './scheduler';
import { StepRunner } from './stepRunner';
import type { OrchestratorDeps, OrchestratorOptions } from './types';

const ack = (serial: string): string => `+ACK:GTGEO,270D04,863457050476769,,0,${serial},20260921220939,03C8`;
const enter = '+RESP:GTGEO,270D04,863457050476769,,,01,1,1,0.0,0,2257.0,-99.127905,19.355447,20260921220959,0334,0020,0336,8F3D,00,0.2,20260921220959,03C9';
const exit = '+RESP:GTGEO,270D04,863457050476769,,,00,1,1,3.3,79,2258.0,-99.127571,19.355516,20260921221159,0334,0020,2C1A,90489A1,00,0.2,20260921221159,03CD';
const point = (pointId: number, longitude: number) => ({ pointId, order: pointId, siteId: pointId,
  latitude: 19.355383, longitude, radiusM: 50, radiusAdjusted: false });

beforeEach(async () => {
  const redis: Redis = new RedisMock();
  await redis.flushall();
  redis.disconnect();
});

function setup(dryRun = false) {
  const redis: Redis = new RedisMock();
  const routeStates = new RedisRouteStateStore(redis);
  const cursors = new RedisChainCursorStore(redis);
  let time = Date.parse('2026-11-17T12:00:00.000Z');
  const scheduler = new FakeScheduler(time);
  const sent: GatewayRequest[] = [];
  const warnings: string[] = [];
  const frames: ChainFrame[] = [];
  let nextFrameId = 1;
  let batchLimit = Number.POSITIVE_INFINITY;
  let gatewayResult: GatewayResult = dryRun ? { kind: 'DRY_RUN' } :
    { kind: 'ACCEPTED', httpStatus: 200, apiCommandId: null, apiStatus: 'SENT_UNCONFIRMED' };
  let plan: RoutePlan = { routeType: 0, points: [point(1, -99.128206), point(2, -99.129206)] };
  let planFails = false;
  const row: AssignmentRow = { assignmentId: 42, companyId: 364, unitId: 81, catalogRouteId: 17,
    estado: 1, enUso: true, horaInicial: new Date(time - 1000), horaFinal: new Date(time + 3600000), modificadoEn: null };
  const opts: OrchestratorOptions = { enabledCompanies: new Map([[364, 2]]), startMarginMinutes: 15,
    pollIntervalMsRoutes: 10000, pollIntervalMsAck: 3000, ackRetryBackoffMs: 60000,
    ackMaxRetries: 3, ackResendEnabled: true, dryRun, now: () => time };
  const deps: OrchestratorDeps = {
    detectors: {
      assignments: { listVigentes: async () => row.enUso ? [row] : [], getById: async () => row },
      chains: { initCursor: async () => ({ partition: '202611', dtTrama: null, recentIds: [] }),
        readNew: async (deviceId, cursor) => {
          const available = frames.filter((frame) => frame.deviceId === deviceId && frame.frameId > (cursor.recentIds[0] ?? 0));
          const selected = available.slice(0, batchLimit);
          return { frames: selected, cursor: { ...cursor, recentIds: [selected.at(-1)?.frameId ?? cursor.recentIds[0] ?? 0] },
            hasMore: available.length > selected.length };
        } },
    },
    catalog: { devices: { resolveForRouteStart: async () => ({ unitId: 81, companyId: 364, deviceId: 9001, modelId: 25, model: 'GV300W' }) },
      plans: { getPlan: async () => { if (planFails) throw new Error('plan unavailable'); return plan; } } },
    gateway: { send: async (request) => { sent.push(request); return gatewayResult; } },
    routeStates, cursors, scheduler,
    logger: { debug: () => undefined, info: () => undefined, warn: (event) => { warnings.push(event); }, error: () => undefined },
  };
  const mutex = new KeyedMutex();
  const unitIndex = new Map<number, number>();
  const commandFor = async (state: RouteState): Promise<string> => {
    const { buildGeoCommand, buildResetCommand, profileFor } = await import('../protocol');
    const profile = profileFor(state.model);
    const serial = state.stepSeq.toString(16).toUpperCase().padStart(4, '0');
    if (state.currentPointId === null) return buildResetCommand(profile, serial);
    const current = plan.points.find((item) => item.pointId === state.currentPointId)!;
    return buildGeoCommand(profile, { latitude: current.latitude, longitude: current.longitude,
      radiusM: current.radiusM, mode: 3, serial });
  };
  const runner = new StepRunner(deps, opts, commandFor);
  scheduler.onTask((task) => mutex.run(task.assignmentId, () => runner.onTask(task)));
  const assignments = new AssignmentCycle(deps, opts, unitIndex, runner, mutex);
  const chains = new ChainPoller(deps, opts, unitIndex, runner, mutex);
  return { redis, routeStates, cursors, scheduler, sent, warnings, row, deps, opts, runner, assignments, chains,
    setPlan: (value: RoutePlan) => { plan = value; }, setPlanFails: (value: boolean) => { planFails = value; },
    setGatewayResult: (value: GatewayResult) => { gatewayResult = value; },
    setBatchLimit: (value: number) => { batchLimit = value; },
    frame: (raw: string) => { frames.push({ frameId: nextFrameId++, deviceId: 9001,
      receivedAt: '2026-11-17 12:00:00', raw: Buffer.from(raw, 'latin1') }); },
    advance: async (ms: number) => { time += ms; await scheduler.advance(ms); },
  };
}

test('ruta de dos puntos llega a COMPLETED con reset y seriales sucesivos', async () => {
  const h = setup();
  try {
    await h.assignments.run();
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_ACK');
    h.frame(ack('0000')); await h.chains.run();
    h.frame(enter); await h.chains.run();
    h.frame(exit); await h.chains.run();
    expect(h.sent[1].command).toContain(',0001$');
    h.frame(ack('0001')); await h.chains.run();
    h.frame(exit); await h.chains.run();
    expect(h.sent[2].command).toContain(',0,0.000000,0.000000,50,');
    h.frame(ack('0002')); await h.chains.run();
    expect((await h.routeStates.get(42))?.fsmState).toBe('COMPLETED');
    expect(h.sent.map((request) => request.idempotencyKey)).toEqual(['42-0-1', '42-1-1', '42-2-1']);
  } finally { h.redis.disconnect(); }
});

test('tras reiniciar se retransmite el comando aceptado aunque cambie el plan', async () => {
  const h = setup();
  try {
    await h.assignments.run();
    const original = h.sent[0].command;
    h.setPlan({ routeType: 0, points: [point(1, -90), point(2, -91)] });
    const resumed = new StepRunner(h.deps, h.opts, async () => 'COMANDO_DEL_PLAN_NUEVO');
    h.scheduler.onTask((task) => resumed.onTask(task));
    await resumed.resume((await h.routeStates.get(42))!);
    expect(h.scheduler.count()).toBe(1);
    await h.advance(60000);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].command).toBe(original);
    expect(h.sent[1].idempotencyKey).toBe('42-0-2');
    expect(h.sent[1].command).toContain(',0000$');
  } finally { h.redis.disconnect(); }
});

test('estado antiguo sin comando reconstruye y alerta al retransmitir', async () => {
  const h = setup();
  try {
    await h.assignments.run();
    await h.routeStates.set({ ...(await h.routeStates.get(42))!, lastAcceptedCommand: null });
    await h.advance(60000);
    expect(h.sent).toHaveLength(2);
    expect(h.warnings).toContain('accepted_command_missing_rebuilt');
  } finally { h.redis.disconnect(); }
});

test('modo sombra no programa ni retransmite, incluso tras reiniciar', async () => {
  const h = setup(true);
  try {
    await h.assignments.run();
    expect((await h.routeStates.get(42))?.ackDeadline).toBeNull();
    expect(h.scheduler.count()).toBe(0);
    await new StepRunner(h.deps, h.opts, async () => 'unused').resume((await h.routeStates.get(42))!);
    await h.advance(600000);
    expect(h.sent).toHaveLength(1);
    expect(h.warnings).not.toContain('ack_retry_batch_exhausted');
  } finally { h.redis.disconnect(); }
});

test('UNCERTAIN repite la misma clave y comando; ACK cancela el reintento', async () => {
  const h = setup();
  try {
    h.setGatewayResult({ kind: 'UNCERTAIN', cause: 'network' });
    await h.assignments.run();
    expect((await h.routeStates.get(42))?.fsmState).toBe('CONFIGURING');
    await h.advance(1000);
    expect(h.sent[1]).toEqual(h.sent[0]);
    h.frame(ack('0000')); await h.chains.run();
    await h.advance(60000);
    expect(h.sent).toHaveLength(2);
  } finally { h.redis.disconnect(); }
});

test('si getPlan falla al salir, el cursor conserva la trama y la aplica luego', async () => {
  const h = setup();
  try {
    await h.assignments.run();
    h.frame(ack('0000')); await h.chains.run();
    const before = await h.cursors.get(9001);
    h.frame(exit);
    h.setPlanFails(true); await h.chains.run();
    expect(await h.cursors.get(9001)).toEqual(before);
    expect((await h.routeStates.get(42))?.fsmState).toBe('IN_ZONE');
    h.setPlanFails(false); await h.chains.run();
    expect((await h.routeStates.get(42))?.currentPointId).toBe(2);
    expect(h.sent).toHaveLength(2);
  } finally { h.redis.disconnect(); }
});

test('cierre no vigente transmite reset y elimina tras su ACK', async () => {
  const h = setup();
  try {
    await h.assignments.run();
    h.row.enUso = false;
    await h.assignments.run();
    expect((await h.routeStates.get(42))?.closing?.reason).toBe('ASSIGNMENT_ENDED');
    h.frame(ack('0001')); await h.chains.run();
    expect(await h.routeStates.get(42)).toBeNull();
    expect(await h.cursors.get(9001)).toBeNull();
  } finally { h.redis.disconnect(); }
});

test('ackResendEnabled=false conserva el paso y reprograma otra ventana', async () => {
  const h = setup();
  try {
    h.opts.ackResendEnabled = false;
    await h.assignments.run();
    await h.advance(60000);
    expect(h.sent).toHaveLength(1);
    expect(h.warnings).toContain('ack_window_expired');
    expect(h.scheduler.count()).toBe(1);
    await h.advance(60000);
    expect(h.warnings.filter((event) => event === 'ack_window_expired')).toHaveLength(2);
  } finally { h.redis.disconnect(); }
});

test('DEFINITIVE_ERROR reintenta a cinco minutos con la misma petición', async () => {
  const h = setup();
  try {
    h.setGatewayResult({ kind: 'DEFINITIVE_ERROR', httpStatus: 422, reason: 'invalid' });
    await h.assignments.run();
    expect(h.warnings).toContain('gateway_definitive_error');
    await h.advance(299999);
    expect(h.sent).toHaveLength(1);
    await h.advance(1);
    expect(h.sent[1]).toEqual(h.sent[0]);
  } finally { h.redis.disconnect(); }
});

test('ruta desordenada emite una sola alerta y no crea estado', async () => {
  const h = setup();
  try {
    h.setPlan({ routeType: 1, points: [point(1, -99)] });
    await h.assignments.run();
    await h.assignments.run();
    expect(await h.routeStates.list()).toEqual([]);
    expect(h.warnings.filter((event) => event === 'ROUTE_TYPE_UNORDERED_SKIPPED')).toHaveLength(1);
  } finally { h.redis.disconnect(); }
});

test('la ventana de inicio y la empresa habilitada restringen el arranque', async () => {
  const h = setup();
  try {
    h.row.horaInicial = new Date('2026-11-17T14:00:00Z');
    await h.assignments.run();
    expect(await h.routeStates.list()).toEqual([]);
    h.row.horaInicial = new Date('2026-11-17T11:59:00Z');
    h.opts.enabledCompanies.clear();
    await h.assignments.run();
    expect(await h.routeStates.list()).toEqual([]);
  } finally { h.redis.disconnect(); }
});

test('el siguiente paso usa el primer punto no cumplido del plan actualizado', async () => {
  const h = setup();
  try {
    await h.assignments.run();
    h.frame(ack('0000')); await h.chains.run();
    h.setPlan({ routeType: 0, points: [point(1, -99), point(3, -98), point(2, -97)] });
    h.frame(exit); await h.chains.run();
    expect((await h.routeStates.get(42))?.currentPointId).toBe(3);
    expect(h.sent[1].command).toContain('-98.000000');
  } finally { h.redis.disconnect(); }
});

test('start recupera estado y stop cierra el scheduler', async () => {
  const h = setup();
  try {
    await h.assignments.run();
    const scheduler = new FakeScheduler();
    const deps = { ...h.deps, scheduler };
    const orchestrator = createOrchestrator(deps, { ...h.opts, pollIntervalMsRoutes: 60000, pollIntervalMsAck: 60000 });
    await orchestrator.start();
    expect(scheduler.count()).toBe(1);
    expect(h.sent).toHaveLength(1);
    await orchestrator.stop();
    expect(scheduler.count()).toBe(0);
  } finally { h.redis.disconnect(); }
});

test('hasMore procesa hasta cinco lotes por recorrido y conserva el cursor', async () => {
  const h = setup();
  try {
    await h.assignments.run();
    h.setBatchLimit(1);
    for (let index = 0; index < 6; index += 1) h.frame('trama-desconocida');
    await h.chains.run();
    expect((await h.cursors.get(9001))?.recentIds).toEqual([5]);
    await h.chains.run();
    expect((await h.cursors.get(9001))?.recentIds).toEqual([6]);
  } finally { h.redis.disconnect(); }
});

test('dos asignaciones de la misma unidad eligen la hora inicial más temprana', async () => {
  const h = setup();
  try {
    const other = { ...h.row, assignmentId: 43, horaInicial: new Date(h.row.horaInicial.getTime() + 1000) };
    h.deps.detectors.assignments.listVigentes = async () => [other, h.row];
    await h.assignments.run();
    expect((await h.routeStates.list()).map((state) => state.assignmentId)).toEqual([42]);
    expect(h.sent).toHaveLength(1);
  } finally { h.redis.disconnect(); }
});

test('AuditUnavailableError conserva la petición para reintentar', async () => {
  const h = setup();
  try {
    h.deps.gateway.send = async (request) => { h.sent.push(request); throw new AuditUnavailableError(); };
    await h.assignments.run();
    expect(h.warnings).toContain('audit_unavailable');
    expect((await h.routeStates.get(42))?.pendingRequest?.idempotencyKey).toBe('42-0-1');
    await h.advance(1000);
    expect(h.sent[1]).toEqual(h.sent[0]);
  } finally { h.redis.disconnect(); }
});
