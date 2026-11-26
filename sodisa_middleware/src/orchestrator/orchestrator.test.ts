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
import { createChainQueryLimiter } from './chainQueryLimiter';
import type { OrchestratorDeps, OrchestratorOptions } from './types';
import { route2035162Frames } from './__fixtures__/route2035162';

const ack = (serial: string): string => `+ACK:GTGEO,270D04,863457050476769,,0,${serial},20260921220939,03C8`;
const outAck = (serial: string): string => `+ACK:GTOUT,270D04,863457050476769,,${serial},20260921220939,03C8$`;
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
    estado: 3, enUso: true, horaInicial: new Date(time - 1000), horaFinal: new Date(time + 3600000), modificadoEn: null };
  const opts: OrchestratorOptions = { enabledCompanies: new Map([[364, 2]]),
    pollIntervalMsRoutes: 10000, chainPollIntervalMs: 60000, chainMaxQueriesPerSecond: 3,
    ackRetryBackoffMs: 180_000,
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
    routeStates, cursors, scheduler, chainQueryLimiter: createChainQueryLimiter(3, () => time),
    logger: { debug: () => undefined, info: () => undefined, warn: (event) => { warnings.push(event); }, error: () => undefined },
  };
  const mutex = new KeyedMutex();
  const unitIndex = new Map<number, number>();
  const commandFor = async (state: RouteState): Promise<string> => {
    const { buildGeoCommand, buildResetCommand, buildOutOffCommand, profileFor } = await import('../protocol');
    const profile = profileFor(state.model);
    const serial = state.stepSeq.toString(16).toUpperCase().padStart(4, '0');
    if (state.currentPointId === null) return state.closingPhase === 'OUT_OFF'
      ? buildOutOffCommand(profile, serial) : buildResetCommand(profile, serial);
    const current = plan.points.find((item) => item.pointId === state.currentPointId)!;
    return buildGeoCommand(profile, { latitude: current.latitude, longitude: current.longitude,
      radiusM: current.radiusM, mode: 3, serial });
  };
  const runner = new StepRunner(deps, opts, commandFor);
  scheduler.onTask((task) => mutex.run(task.assignmentId, () => runner.onTask(task)));
  const assignments = new AssignmentCycle(deps, opts, unitIndex, runner, mutex);
  const chains = new ChainPoller(deps, opts, unitIndex, runner, mutex);
  let lastChainRun: number | null = null;
  return { redis, routeStates, cursors, scheduler, sent, warnings, row, deps, opts, runner, assignments, chains,
    runAssignments: async () => { await assignments.run(); await assignments.waitPending(); },
    pollChains: async () => {
      if (lastChainRun !== null) time = Math.max(time, lastChainRun + opts.chainPollIntervalMs);
      await chains.run();
      lastChainRun = time;
    },
    setPlan: (value: RoutePlan) => { plan = value; }, setPlanFails: (value: boolean) => { planFails = value; },
    setGatewayResult: (value: GatewayResult) => { gatewayResult = value; },
    setBatchLimit: (value: number) => { batchLimit = value; },
    frame: (raw: string, receivedAt = '2026-11-17 12:00:00') => { frames.push({ frameId: nextFrameId++, deviceId: 9001,
      receivedAt, raw: Buffer.from(raw, 'latin1') }); },
    advance: async (ms: number) => { time += ms; await scheduler.advance(ms); },
  };
}

test('ruta de dos puntos llega a COMPLETED con reset y seriales sucesivos', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_ACK');
    h.frame(ack('0000')); await h.pollChains();
    h.frame(enter); await h.pollChains();
    h.frame(exit); await h.pollChains();
    expect(h.sent[1].command).toContain(',0001$');
    h.frame(ack('0001')); await h.pollChains();
    h.frame(enter); await h.pollChains();
    h.frame(exit); await h.pollChains();
    expect(h.sent[2].command).toContain(',0,0.000000,0.000000,50,');
    h.frame(ack('0002')); await h.pollChains();
    expect((await h.routeStates.get(42))).toMatchObject({ fsmState: 'AWAITING_ACK', closingPhase: 'OUT_OFF', stepSeq: 3 });
    expect(h.sent[3].command).toBe('AT+GTOUT=gv300w,,,,,,,0,,,,,,,,,,0003$');
    h.frame(outAck('0003')); await h.pollChains();
    expect((await h.routeStates.get(42))?.fsmState).toBe('COMPLETED');
    expect(h.sent.map((request) => request.idempotencyKey)).toEqual(['42-0-1', '42-1-1', '42-2-1', '42-3-1']);
    await h.runAssignments();
    expect((await h.routeStates.get(42))?.fsmState).toBe('COMPLETED');
    expect(h.sent).toHaveLength(4);
  } finally { h.redis.disconnect(); }
});

test('ACK, salida, entrada y salida en un mismo lote solo avanzan tras la entrada', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    h.deps.logger.info = jest.fn();
    const getPlan = jest.spyOn(h.deps.catalog.plans, 'getPlan');
    h.frame(ack('0000'), '2026-11-17 12:00:01');
    h.frame(exit, '2026-11-17 12:00:02');
    h.frame(enter, '2026-11-17 12:00:03');
    h.frame(exit, '2026-11-17 12:00:04');
    await h.pollChains();
    expect((await h.routeStates.get(42))).toMatchObject({ stepSeq: 1, currentPointId: 2, fsmState: 'AWAITING_ACK' });
    expect(getPlan).toHaveBeenCalledTimes(1);
    expect(h.deps.logger.info).toHaveBeenCalledWith('exit_before_enter_ignored', expect.objectContaining({
      deviceId: 9001, routeId: 42, stepSeq: 0,
    }));
    expect(h.sent).toHaveLength(2);
  } finally { h.redis.disconnect(); }
});

test('ACK, salida, entrada y salida en sondeos separados conservan el orden del paso', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    const getPlan = jest.spyOn(h.deps.catalog.plans, 'getPlan');
    h.frame(ack('0000')); await h.pollChains();
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_ENTER_ALERT');
    h.frame(exit); await h.pollChains();
    expect((await h.routeStates.get(42))).toMatchObject({ fsmState: 'AWAITING_ENTER_ALERT', stepSeq: 0, currentPointId: 1 });
    expect(getPlan).not.toHaveBeenCalled();
    h.frame(enter); await h.pollChains();
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_EXIT_ALERT');
    h.frame(exit); await h.pollChains();
    expect((await h.routeStates.get(42))).toMatchObject({ fsmState: 'AWAITING_ACK', stepSeq: 1, currentPointId: 2 });
    expect(getPlan).toHaveBeenCalledTimes(1);
  } finally { h.redis.disconnect(); }
});

test('entrada antes del ACK no habilita la salida del paso', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    const getPlan = jest.spyOn(h.deps.catalog.plans, 'getPlan');
    h.frame(enter, '2026-11-17 12:00:01');
    h.frame(ack('0000'), '2026-11-17 12:00:02');
    h.frame(exit, '2026-11-17 12:00:03');
    await h.pollChains();
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_ENTER_ALERT');
    expect(getPlan).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(1);
  } finally { h.redis.disconnect(); }
});

test('tramas físicas de 2035162 no saltan los puntos 2 y 3', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    h.frame(route2035162Frames[0].raw, route2035162Frames[0].receivedAt);
    await h.pollChains();
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_ENTER_ALERT');
    h.frame(route2035162Frames[1].raw, route2035162Frames[1].receivedAt);
    await h.pollChains();
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_EXIT_ALERT');
    h.frame(route2035162Frames[2].raw, route2035162Frames[2].receivedAt);
    await h.pollChains();
    expect((await h.routeStates.get(42))).toMatchObject({ stepSeq: 1, currentPointId: 2, fsmState: 'AWAITING_ACK' });
    const getPlan = jest.spyOn(h.deps.catalog.plans, 'getPlan');
    h.deps.logger.info = jest.fn();
    for (const frame of route2035162Frames.slice(3)) h.frame(frame.raw, frame.receivedAt);
    await h.pollChains();
    expect((await h.routeStates.get(42))).toMatchObject({ stepSeq: 1, currentPointId: 2, fsmState: 'AWAITING_ENTER_ALERT' });
    expect(h.sent).toHaveLength(2);
    expect(getPlan).not.toHaveBeenCalled();
    expect(jest.mocked(h.deps.logger.info).mock.calls.filter(([event]) => event === 'exit_before_enter_ignored')).toHaveLength(2);
  } finally { h.redis.disconnect(); }
});

test('ruta reanudada en AWAITING_ENTER_ALERT exige entrada antes de aceptar salida', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    h.frame(ack('0000')); await h.pollChains();
    const resumed = new ChainPoller(h.deps, h.opts, new Map([[81, 42]]), h.runner, new KeyedMutex());
    const getPlan = jest.spyOn(h.deps.catalog.plans, 'getPlan');
    h.deps.logger.info = jest.fn();
    h.frame(exit); await resumed.run();
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_ENTER_ALERT');
    expect(getPlan).not.toHaveBeenCalled();
    expect(h.deps.logger.info).toHaveBeenCalledWith('exit_before_enter_ignored', expect.objectContaining({ stepSeq: 0 }));
    await h.advance(60_000);
    h.frame(enter); h.frame(exit); await resumed.run();
    expect((await h.routeStates.get(42))?.stepSeq).toBe(1);
  } finally { h.redis.disconnect(); }
});

test('tras reiniciar se retransmite el comando aceptado aunque cambie el plan', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    const original = h.sent[0].command;
    const firstTransmissionAt = (await h.routeStates.get(42))?.firstTransmissionAt;
    expect(firstTransmissionAt).toBe('2026-11-17T12:00:00.000Z');
    h.setPlan({ routeType: 0, points: [point(1, -90), point(2, -91)] });
    const resumed = new StepRunner(h.deps, h.opts, async () => 'COMANDO_DEL_PLAN_NUEVO');
    h.scheduler.onTask((task) => resumed.onTask(task));
    await resumed.resume((await h.routeStates.get(42))!);
    expect(h.scheduler.count()).toBe(1);
    await h.advance(h.opts.ackRetryBackoffMs);
    await h.advance(0);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].command).toBe(original);
    expect(h.sent[1].idempotencyKey).toBe('42-0-2');
    expect(h.sent[1].command).toContain(',0000$');
    expect((await h.routeStates.get(42))?.firstTransmissionAt).toBe(firstTransmissionAt);
  } finally { h.redis.disconnect(); }
});

test('el mínimo no reenvía sin lectura; la lectura posterior sí, tras guardar el cursor', async () => {
  const h = setup();
  try {
    h.opts.ackRetryBackoffMs = 30_000;
    await h.runAssignments();
    await h.advance(30_000);
    expect(h.sent).toHaveLength(1);
    const cursorSet = jest.spyOn(h.cursors, 'set');
    await h.pollChains();
    expect(cursorSet).toHaveBeenCalled();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].idempotencyKey).toBe('42-0-2');
    expect((await h.routeStates.get(42))?.ackDeadline).toBe(new Date(Date.parse('2026-11-17T12:00:30Z') + 30_000).toISOString());
  } finally { h.redis.disconnect(); }
});

test('un ACK del lote después del mínimo impide retransmitir', async () => {
  const h = setup();
  try {
    h.opts.ackRetryBackoffMs = 30_000;
    await h.runAssignments();
    await h.advance(30_000);
    h.frame(ack('0000'));
    await h.pollChains();
    expect(h.sent).toHaveLength(1);
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_ENTER_ALERT');
    await h.advance(90_000);
    expect(h.sent).toHaveLength(1);
  } finally { h.redis.disconnect(); }
});

test('sin lectura posterior al mínimo la salvaguarda retransmite a dos intervalos', async () => {
  const h = setup();
  try {
    h.opts.ackRetryBackoffMs = 30_000;
    await h.runAssignments();
    await h.pollChains(); // lectura anterior al mínimo
    await h.advance(30_000);
    expect(h.sent).toHaveLength(1);
    await h.advance(89_999);
    expect(h.sent).toHaveLength(1);
    await h.advance(1);
    expect(h.sent[1].idempotencyKey).toBe('42-0-2');
  } finally { h.redis.disconnect(); }
});

test('estado antiguo sin comando reconstruye y alerta al retransmitir', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    await h.routeStates.set({ ...(await h.routeStates.get(42))!, lastAcceptedCommand: null });
    await h.advance(h.opts.ackRetryBackoffMs);
    await h.advance(0);
    expect(h.sent).toHaveLength(2);
    expect(h.warnings).toContain('accepted_command_missing_rebuilt');
  } finally { h.redis.disconnect(); }
});

test('modo sombra no programa ni retransmite, incluso tras reiniciar', async () => {
  const h = setup(true);
  try {
    await h.runAssignments();
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
    await h.runAssignments();
    expect((await h.routeStates.get(42))?.fsmState).toBe('CONFIGURING');
    await h.advance(1000);
    expect(h.sent[1]).toEqual(h.sent[0]);
    h.frame(ack('0000')); await h.pollChains();
    await h.advance(60000);
    expect(h.sent).toHaveLength(2);
  } finally { h.redis.disconnect(); }
});

test('si getPlan falla al salir, el cursor conserva la trama y la aplica luego', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    h.frame(ack('0000')); await h.pollChains();
    h.frame(enter); await h.pollChains();
    const before = await h.cursors.get(9001);
    h.frame(exit);
    h.setPlanFails(true); await h.pollChains();
    expect(await h.cursors.get(9001)).toEqual(before);
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_EXIT_ALERT');
    h.setPlanFails(false); await h.pollChains();
    expect((await h.routeStates.get(42))?.currentPointId).toBe(2);
    expect(h.sent).toHaveLength(2);
  } finally { h.redis.disconnect(); }
});

test('cierre no vigente transmite reset y GTOUT antes de eliminar', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    h.row.enUso = false;
    await h.runAssignments();
    expect((await h.routeStates.get(42))?.closing?.reason).toBe('ASSIGNMENT_ENDED');
    h.frame(ack('0001')); await h.pollChains();
    expect((await h.routeStates.get(42))?.closingPhase).toBe('OUT_OFF');
    h.frame(outAck('0002')); await h.pollChains();
    expect(await h.routeStates.get(42)).toBeNull();
    expect(await h.cursors.get(9001)).toBeNull();
  } finally { h.redis.disconnect(); }
});

test('el reset de cierre se retransmite aunque la asignación ya no sea vigente', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    h.row.enUso = false;
    await h.runAssignments();
    const reset = h.sent[1].command;
    await h.advance(h.opts.ackRetryBackoffMs);
    await h.advance(0);
    expect(h.sent).toHaveLength(3);
    expect(h.sent[2].command).toBe(reset);
    expect(h.sent[2].idempotencyKey).toBe('42-1-2');
  } finally { h.redis.disconnect(); }
});

test('GTOUT se reanuda y retransmite con su comando y serial hasta recibir su ACK', async () => {
  const h = setup();
  try {
    h.opts.ackRetryBackoffMs = 30_000;
    await h.runAssignments();
    h.row.enUso = false;
    await h.runAssignments();
    const resetState = (await h.routeStates.get(42))!;
    await new StepRunner(h.deps, h.opts, async () => 'unused').resume(resetState);
    h.frame(ack('0001')); await h.pollChains();
    const outState = (await h.routeStates.get(42))!;
    expect(outState).toMatchObject({ closingPhase: 'OUT_OFF', fsmState: 'AWAITING_ACK', stepSeq: 2 });
    await new StepRunner(h.deps, h.opts, async () => 'unused').resume(outState);
    await h.advance(30_000);
    expect(h.sent).toHaveLength(3);
    await h.advance(90_000);
    expect(h.sent[3]).toMatchObject({ idempotencyKey: '42-2-2', command: outState.lastAcceptedCommand });
    h.frame(ack('0002')); await h.pollChains();
    expect((await h.routeStates.get(42))?.closingPhase).toBe('OUT_OFF');
    h.frame(outAck('0002')); await h.pollChains();
    expect(await h.routeStates.get(42)).toBeNull();
  } finally { h.redis.disconnect(); }
});

test('COMPLETED deja empezar B; avisos se deduplican y borrar A conserva índice y cursor de B', async () => {
  const h = setup();
  try {
    const b: AssignmentRow = { ...h.row, assignmentId: 43, horaInicial: new Date(h.row.horaInicial.getTime() + 1000) };
    h.deps.detectors.assignments.listVigentes = async () => [h.row, b].filter((row) => row.enUso);
    h.deps.detectors.assignments.getById = async (id) => id === 42 ? h.row : b;
    h.deps.logger.info = jest.fn();
    h.deps.logger.debug = jest.fn();
    await h.runAssignments();
    await h.runAssignments();
    expect(h.warnings.filter((event) => event === 'unit_already_in_route')).toHaveLength(1);
    h.frame(ack('0000')); await h.pollChains();
    h.frame(enter); await h.pollChains();
    h.frame(exit); await h.pollChains();
    h.frame(ack('0001')); await h.pollChains();
    h.frame(enter); await h.pollChains();
    h.frame(exit); await h.pollChains();
    h.frame(ack('0002')); await h.pollChains();
    h.frame(outAck('0003')); await h.pollChains();
    expect((await h.routeStates.get(42))?.fsmState).toBe('COMPLETED');
    await h.runAssignments();
    expect((await h.routeStates.get(43))?.fsmState).toBe('AWAITING_ACK');
    expect(h.deps.logger.info).toHaveBeenCalledWith('assignment_skipped_completed', expect.objectContaining({ routeId: 42 }));
    expect(h.deps.logger.debug).toHaveBeenCalledWith('assignment_poll', expect.objectContaining({ candidateIds: [43] }));
    const cursorB = await h.cursors.get(9001);
    h.row.enUso = false;
    await h.runAssignments();
    expect(await h.routeStates.get(42)).toBeNull();
    expect((await h.routeStates.getByDevice(9001))?.assignmentId).toBe(43);
    expect(await h.cursors.get(9001)).toEqual(cursorB);
    expect(jest.mocked(h.deps.logger.info).mock.calls.filter(([event]) => event === 'assignment_skipped_completed')).toHaveLength(1);
  } finally { h.redis.disconnect(); }
});

test('ackResendEnabled=false conserva el paso y reprograma otra ventana', async () => {
  const h = setup();
  try {
    h.opts.ackResendEnabled = false;
    await h.runAssignments();
    await h.advance(h.opts.ackRetryBackoffMs);
    await h.advance(0);
    expect(h.sent).toHaveLength(1);
    expect(h.warnings).toContain('ack_window_expired');
    expect(h.scheduler.count()).toBe(1);
    await h.advance(h.opts.ackRetryBackoffMs);
    expect(h.warnings.filter((event) => event === 'ack_window_expired')).toHaveLength(2);
  } finally { h.redis.disconnect(); }
});

test('DEFINITIVE_ERROR reintenta a cinco minutos con la misma petición', async () => {
  const h = setup();
  try {
    h.setGatewayResult({ kind: 'DEFINITIVE_ERROR', httpStatus: 422, reason: 'invalid' });
    await h.runAssignments();
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
    await h.runAssignments();
    await h.runAssignments();
    expect(await h.routeStates.list()).toEqual([]);
    expect(h.warnings.filter((event) => event === 'ROUTE_TYPE_UNORDERED_SKIPPED')).toHaveLength(1);
  } finally { h.redis.disconnect(); }
});

test('horaInicial futura no impide iniciar un estado 3', async () => {
  const h = setup();
  try {
    h.row.horaInicial = new Date('2026-11-17T14:00:00Z');
    await h.runAssignments();
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_ACK');
  } finally { h.redis.disconnect(); }
});

test('empresa deshabilitada impide iniciar', async () => {
  const h = setup();
  try {
    h.opts.enabledCompanies.clear();
    await h.runAssignments();
    expect(await h.routeStates.list()).toEqual([]);
  } finally { h.redis.disconnect(); }
});

test.each([3, 4])('estado %s inicia con hora final nula', async (estado) => {
  const h = setup();
  try {
    h.row.estado = estado;
    h.row.horaFinal = null;
    await h.runAssignments();
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_ACK');
  } finally { h.redis.disconnect(); }
});

test.each([null, new Date('2026-11-17T11:00:00Z'), new Date('2026-11-17T14:00:00Z')])(
  'la hora final %s no altera el inicio de una asignación vigente', async (horaFinal) => {
  const h = setup();
  try {
    h.row.horaFinal = horaFinal;
    await h.runAssignments();
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_ACK');
  } finally { h.redis.disconnect(); }
  });

test('un error inesperado en la primera asignación deja iniciar a la segunda', async () => {
  const h = setup();
  try {
    const other: AssignmentRow = { ...h.row, assignmentId: 43, unitId: 82 };
    h.deps.detectors.assignments.listVigentes = async () => [h.row, other];
    h.deps.detectors.assignments.getById = async (id) => id === 43 ? other : h.row;
    h.deps.catalog.devices.resolveForRouteStart = async (unitId, companyId) =>
      ({ unitId, companyId, deviceId: 9000 + unitId, modelId: 25, model: 'GV300W' });
    const get = h.routeStates.get.bind(h.routeStates);
    jest.spyOn(h.routeStates, 'get').mockImplementation(async (id) => {
      if (id === 42) throw Object.assign(new Error('postgres://u:<valor>@host/db'), { code: '28P01' });
      return get(id);
    });
    h.deps.logger.error = jest.fn();
    h.deps.logger.debug = jest.fn();
    await h.runAssignments();
    expect((await h.routeStates.list()).map((state) => state.assignmentId)).toEqual([43]);
    expect(h.sent).toHaveLength(1);
    expect(h.deps.logger.error).toHaveBeenCalledWith('assignment_failed', expect.objectContaining({
      assignmentId: 42, companyId: 364, errorName: 'Error', errorCode: '28P01',
      errorMessage: 'postgres://***@host/db',
    }));
    expect(h.deps.logger.debug).toHaveBeenCalledWith('assignment_poll', expect.objectContaining({ failedAssignments: 1 }));
    expect(JSON.stringify(jest.mocked(h.deps.logger.error).mock.calls)).not.toContain('<valor>');
  } finally { h.redis.disconnect(); }
});

test('poll_failed conserva causa y código sin credenciales', async () => {
  const h = setup();
  try {
    h.deps.logger.error = jest.fn();
    const list = h.routeStates.list.bind(h.routeStates);
    let calls = 0;
    jest.spyOn(h.routeStates, 'list').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return list();
      throw Object.assign(new Error('postgres://u:<valor>@host/db'), { code: 'ECONNREFUSED' });
    });
    const orchestrator = createOrchestrator(h.deps, { ...h.opts, pollIntervalMsRoutes: 60000 });
    await orchestrator.start();
    expect(h.deps.logger.error).toHaveBeenCalledWith('poll_failed', expect.objectContaining({
      errorName: 'Error', errorCode: 'ECONNREFUSED', errorMessage: 'postgres://***@host/db',
    }));
    expect(JSON.stringify(jest.mocked(h.deps.logger.error).mock.calls)).not.toContain('<valor>');
    await orchestrator.stop();
  } finally { h.redis.disconnect(); }
});

test('el error de consulta de empresa conserva causa y no cuenta una asignación', async () => {
  const h = setup();
  try {
    h.deps.detectors.assignments.listVigentes = async () => {
      throw Object.assign(new Error('postgres://u:<valor>@host/db'), { code: '28P01' });
    };
    h.deps.logger.error = jest.fn();
    h.deps.logger.debug = jest.fn();
    await h.runAssignments();
    expect(h.deps.logger.error).toHaveBeenCalledWith('assignment_poll_failed', expect.objectContaining({
      companyId: 364, errorCode: '28P01', errorMessage: 'postgres://***@host/db',
    }));
    expect(h.deps.logger.debug).toHaveBeenCalledWith('assignment_poll', expect.objectContaining({ failedAssignments: 0 }));
  } finally { h.redis.disconnect(); }
});

test('chain_poll_failed registra la causa redactada del equipo', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    h.deps.detectors.chains.readNew = async () => {
      throw Object.assign(new Error('redis://:<valor>@host/0'), { code: 'ECONNREFUSED' });
    };
    h.deps.logger.error = jest.fn();
    await h.pollChains();
    expect(h.deps.logger.error).toHaveBeenCalledWith('chain_poll_failed', expect.objectContaining({
      routeId: 42, deviceId: 9001, errorCode: 'ECONNREFUSED', errorMessage: 'redis://***@host/0',
    }));
  } finally { h.redis.disconnect(); }
});

test('route_resume_failed registra causa y el fallo pertenece a esa asignación', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    await h.routeStates.set({ ...(await h.routeStates.get(42))!, fsmState: 'PENDING', transmissionSeq: 0,
      pendingRequest: null });
    jest.spyOn(h.routeStates, 'set').mockRejectedValueOnce(Object.assign(new Error('postgres://u:<valor>@host/db'),
      { code: '28P01' }));
    h.deps.logger.error = jest.fn();
    h.deps.logger.debug = jest.fn();
    await h.runAssignments();
    expect(h.deps.logger.error).toHaveBeenCalledWith('route_resume_failed', expect.objectContaining({
      routeId: 42, errorCode: '28P01', errorMessage: 'postgres://***@host/db',
    }));
    expect(h.deps.logger.debug).toHaveBeenCalledWith('assignment_poll', expect.objectContaining({ failedAssignments: 1 }));
  } finally { h.redis.disconnect(); }
});

test('estado 4 inicia directamente y el estado 1 espera sin consultar tramas ni transmitir', async () => {
  const h = setup();
  try {
    h.row.estado = 1;
    const initCursor = jest.spyOn(h.deps.detectors.chains, 'initCursor');
    const readNew = jest.spyOn(h.deps.detectors.chains, 'readNew');
    const resolve = jest.spyOn(h.deps.catalog.devices, 'resolveForRouteStart');
    await h.runAssignments();
    await h.pollChains();
    expect(await h.routeStates.list()).toEqual([]);
    expect(h.sent).toHaveLength(0);
    expect(initCursor).not.toHaveBeenCalled();
    expect(readNew).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    h.row.estado = 4;
    h.row.enUso = false;
    await h.runAssignments();
    expect(await h.routeStates.list()).toEqual([]);
    h.row.enUso = true;
    await h.runAssignments();
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_ACK');
    expect(h.sent).toHaveLength(1);
  } finally { h.redis.disconnect(); }
});

test.each([-1, 0, 2, 5, 6, 7])('estado %s nunca inicia una ruta', async (estado) => {
  const h = setup();
  try {
    h.row.estado = estado;
    await h.runAssignments();
    expect(await h.routeStates.list()).toEqual([]);
    expect(h.sent).toHaveLength(0);
  } finally { h.redis.disconnect(); }
});

test('el paso 3 a 4 y de regreso conserva estado y temporizador', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    const original = await h.routeStates.get(42);
    expect(h.scheduler.count()).toBe(1);
    h.row.estado = 4;
    await h.runAssignments();
    expect(await h.routeStates.get(42)).toEqual(original);
    expect(h.scheduler.count()).toBe(1);
    h.row.estado = 3;
    await h.runAssignments();
    expect(await h.routeStates.get(42)).toEqual(original);
    expect(h.scheduler.count()).toBe(1);
    expect(h.sent).toHaveLength(1);
  } finally { h.redis.disconnect(); }
});

test.each([1, 2, 5, 6, 7])('estado final %s cierra con reset tras una transmisión', async (estado) => {
  const h = setup();
  try {
    await h.runAssignments();
    h.row.estado = estado;
    await h.runAssignments();
    expect((await h.routeStates.get(42))?.closing).toEqual({ reason: 'ASSIGNMENT_ENDED', finalEstado: estado });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].command).toContain(',0,0.000000,0.000000,50,');
  } finally { h.redis.disconnect(); }
});

test('la retransmisión continúa al pasar de estado 3 a 4', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    h.row.estado = 4;
    await h.advance(h.opts.ackRetryBackoffMs);
    await h.advance(0);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].idempotencyKey).toBe('42-0-2');
  } finally { h.redis.disconnect(); }
});

test('el siguiente paso usa el primer punto no cumplido del plan actualizado', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    h.frame(ack('0000')); await h.pollChains();
    h.frame(enter); await h.pollChains();
    h.setPlan({ routeType: 0, points: [point(1, -99), point(3, -98), point(2, -97)] });
    h.frame(exit); await h.pollChains();
    expect((await h.routeStates.get(42))?.currentPointId).toBe(3);
    expect(h.sent[1].command).toContain('-98.000000');
  } finally { h.redis.disconnect(); }
});

test('start recupera estado y stop cierra el scheduler', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    const scheduler = new FakeScheduler();
    const deps = { ...h.deps, scheduler };
    const orchestrator = createOrchestrator(deps, { ...h.opts, pollIntervalMsRoutes: 60000 });
    await orchestrator.start();
    expect(scheduler.count()).toBe(1);
    expect(h.sent).toHaveLength(1);
    await orchestrator.stop();
    expect(scheduler.count()).toBe(0);
  } finally { h.redis.disconnect(); }
});

test('hasMore reencola lotes sin lectura inmediata y conserva el cursor', async () => {
  const h = setup();
  try {
    await h.runAssignments();
    h.setBatchLimit(1);
    for (let index = 0; index < 6; index += 1) h.frame('trama-desconocida');
    await h.pollChains();
    expect((await h.cursors.get(9001))?.recentIds).toEqual([1]);
    for (let index = 0; index < 5; index += 1) await h.pollChains();
    expect((await h.cursors.get(9001))?.recentIds).toEqual([6]);
  } finally { h.redis.disconnect(); }
});

test('dos asignaciones de la misma unidad eligen la hora inicial más temprana', async () => {
  const h = setup();
  try {
    const other = { ...h.row, assignmentId: 43, horaInicial: new Date(h.row.horaInicial.getTime() + 1000) };
    h.deps.detectors.assignments.listVigentes = async () => [other, h.row];
    await h.runAssignments();
    expect((await h.routeStates.list()).map((state) => state.assignmentId)).toEqual([42]);
    expect(h.sent).toHaveLength(1);
  } finally { h.redis.disconnect(); }
});

test('el sondeo de asignaciones no espera un cursor pendiente', async () => {
  const h = setup();
  try {
    let release: ((value: { partition: string; dtTrama: null; recentIds: number[] }) => void) | undefined;
    h.deps.detectors.chains.initCursor = async () => new Promise((resolve) => { release = resolve; });
    const list = jest.spyOn(h.deps.detectors.assignments, 'listVigentes');
    await h.assignments.run();
    expect(await h.routeStates.list()).toEqual([]);
    await h.assignments.run();
    expect(list).toHaveBeenCalledTimes(2);
    release?.({ partition: '202647', dtTrama: null, recentIds: [] });
    await h.assignments.waitPending();
    expect((await h.routeStates.get(42))?.fsmState).toBe('AWAITING_ACK');
  } finally { h.redis.disconnect(); }
});

test('no transmite si la asignación pierde vigencia mientras espera el cursor', async () => {
  const h = setup();
  try {
    let release!: (value: { partition: string; dtTrama: null; recentIds: number[] }) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const cursor = new Promise<{ partition: string; dtTrama: null; recentIds: number[] }>((resolve) => { release = resolve; });
    h.deps.detectors.chains.initCursor = async () => { entered(); return cursor; };
    await h.assignments.run();
    await waiting;
    h.row.enUso = false;
    release({ partition: '202647', dtTrama: null, recentIds: [] });
    await h.assignments.waitPending();
    expect(await h.routeStates.list()).toEqual([]);
    expect(h.sent).toHaveLength(0);
  } finally { h.redis.disconnect(); }
});

test('un fallo diferido de cursor se cuenta en el siguiente sondeo', async () => {
  const h = setup();
  try {
    h.deps.detectors.chains.initCursor = async () => { throw new Error('consulta fallida'); };
    h.deps.logger.debug = jest.fn();
    h.deps.logger.error = jest.fn();
    await h.assignments.run();
    await h.assignments.waitPending();
    await h.assignments.run();
    const polls = jest.mocked(h.deps.logger.debug).mock.calls.filter(([event]) => event === 'assignment_poll');
    expect(polls[0][1]).toEqual(expect.objectContaining({ failedAssignments: 0 }));
    expect(polls[1][1]).toEqual(expect.objectContaining({ failedAssignments: 1 }));
    await h.assignments.waitPending();
  } finally { h.redis.disconnect(); }
});

test('treinta rutas inicializan sus cursores sin superar el tope SQL', async () => {
  jest.useFakeTimers({ now: 0 });
  const h = setup();
  try {
    const rows = Array.from({ length: 30 }, (_, i) => ({ ...h.row, assignmentId: 100 + i, unitId: 200 + i }));
    h.deps.detectors.assignments.listVigentes = async () => rows;
    h.deps.detectors.assignments.getById = async (id) => rows.find((row) => row.assignmentId === id) ?? null;
    h.deps.catalog.devices.resolveForRouteStart = async (unitId, companyId) =>
      ({ unitId, companyId, deviceId: 9000 + unitId, modelId: 25, model: 'GV300W' });
    const limiter = createChainQueryLimiter(3);
    h.deps.chainQueryLimiter = limiter;
    const queries: number[] = [];
    h.deps.detectors.chains.initCursor = async () => {
      for (let i = 0; i < 2; i += 1) await limiter.run(async () => { queries.push(Date.now()); return { rows: [] }; });
      return { partition: '202647', dtTrama: null, recentIds: [] };
    };
    await h.assignments.run();
    await jest.advanceTimersByTimeAsync(20_000);
    await h.assignments.waitPending();
    expect(await h.routeStates.list()).toHaveLength(30);
    expect(queries).toHaveLength(60);
    for (const at of queries) expect(queries.filter((other) => other >= at && other < at + 1000).length)
      .toBeLessThanOrEqual(3);
    await limiter.close();
  } finally { h.redis.disconnect(); jest.useRealTimers(); }
});

test('AuditUnavailableError conserva la petición para reintentar', async () => {
  const h = setup();
  try {
    h.deps.gateway.send = async (request) => { h.sent.push(request); throw new AuditUnavailableError(); };
    await h.runAssignments();
    expect(h.warnings).toContain('audit_unavailable');
    expect((await h.routeStates.get(42))?.pendingRequest?.idempotencyKey).toBe('42-0-1');
    await h.advance(1000);
    expect(h.sent[1]).toEqual(h.sent[0]);
  } finally { h.redis.disconnect(); }
});
