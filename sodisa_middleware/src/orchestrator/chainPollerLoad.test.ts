import type { RouteState, ChainCursor, RouteStateStore, ChainCursorStore } from '../persistence';
import type { OrchestratorDeps, OrchestratorOptions } from './types';
import { createChainQueryLimiter } from './chainQueryLimiter';
import { ChainPoller } from './chainPoller';
import { KeyedMutex } from './keyedMutex';
import type { StepRunner } from './stepRunner';

function fixture(count: number, rate = 3) {
  const start = Date.parse('2026-11-24T12:00:00Z');
  let time = start;
  const states = new Map<number, RouteState>();
  const cursors = new Map<number, ChainCursor>();
  const timestamps = new Map<number, number[]>();
  const hasMoreOnce = new Set<number>();
  const cursor: ChainCursor = { partition: '202647', dtTrama: null, recentIds: [] };
  const add = (id: number): void => {
    const deviceId = 9000 + id;
    states.set(id, { assignmentId: id, companyId: 364, apiCompanyId: 2, unitId: id, deviceId,
      model: 'GV300W', catalogRouteId: 17, routeType: 0, fsmState: 'AWAITING_ACK', currentPointId: 1,
      completedPointIds: [], stepSeq: 0, transmissionSeq: 1, retryCount: 0, pendingRequest: null,
      lastAcceptedCommand: null, firstTransmissionAt: null, ackDeadline: null, closing: null, startedAt: '', updatedAt: '' });
    cursors.set(deviceId, cursor);
    timestamps.set(deviceId, []);
  };
  for (let id = 1; id <= count; id += 1) add(id);
  const routeStates: RouteStateStore = {
    get: async (id) => states.get(id) ?? null,
    getByDevice: async (id) => [...states.values()].find((state) => state.deviceId === id) ?? null,
    set: async (state) => { states.set(state.assignmentId, state); },
    delete: async (id) => { states.delete(id); },
    list: async () => [...states.values()],
  };
  const cursorStore: ChainCursorStore = {
    get: async (id) => cursors.get(id) ?? null,
    set: async (id, value) => { cursors.set(id, value); },
    delete: async (id) => { cursors.delete(id); },
  };
  const limiter = createChainQueryLimiter(rate, () => time);
  const opts: OrchestratorOptions = { enabledCompanies: new Map([[364, 2]]), pollIntervalMsRoutes: 10000,
    chainPollIntervalMs: 60000, chainMaxQueriesPerSecond: rate, ackRetryBackoffMs: 150000,
    ackMaxRetries: 3, ackResendEnabled: true, dryRun: true, now: () => time };
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const deps = {
    detectors: { assignments: { listVigentes: async () => [], getById: async () => null },
      chains: { initCursor: async () => cursor,
        readNew: async (deviceId: number, current: ChainCursor) => {
          await limiter.run(async () => { timestamps.get(deviceId)!.push(time - start); return { rows: [] }; });
          const hasMore = hasMoreOnce.delete(deviceId);
          return { frames: [], cursor: current, hasMore };
        } } },
    routeStates, cursors: cursorStore, chainQueryLimiter: limiter, logger,
    catalog: { devices: { resolveForRouteStart: jest.fn() }, plans: { getPlan: jest.fn() } },
    gateway: { send: jest.fn() }, scheduler: { schedule: jest.fn(), cancel: jest.fn(),
      onTask: jest.fn(), close: jest.fn() },
  } as unknown as OrchestratorDeps;
  const poller = new ChainPoller(deps, opts, new Map(), {} as StepRunner, new KeyedMutex());
  return { add, poller, timestamps, logger, limiter, setTime: (value: number) => { time = start + value; },
    setHasMoreOnce: (id: number) => { hasMoreOnce.add(id); } };
}

function assertWindowCap(timestamps: Map<number, number[]>, cap: number): void {
  const all = [...timestamps.values()].flat().sort((a, b) => a - b);
  for (const at of all) expect(all.filter((other) => other >= at && other < at + 1000).length).toBeLessThanOrEqual(cap);
}

test('60 equipos se distribuyen a lo largo de 10 minutos sin superar 3 consultas por segundo', async () => {
  const h = fixture(60);
  for (let time = 0; time < 600_000; time += 1000) { h.setTime(time); await h.poller.run(); }
  for (const times of h.timestamps.values()) expect(times.length).toBeGreaterThanOrEqual(9);
  for (const times of h.timestamps.values()) expect(times.length).toBeLessThanOrEqual(11);
  assertWindowCap(h.timestamps, 3);
  expect(h.logger.warn).not.toHaveBeenCalledWith('chain_poll_saturated', expect.anything());
  await h.limiter.close();
});

test('200 equipos saturan el tope y el aviso se emite a lo más una vez por minuto', async () => {
  const h = fixture(200);
  for (let time = 0; time < 130_000; time += 334) { h.setTime(time); await h.poller.run(); }
  assertWindowCap(h.timestamps, 3);
  const warnings = jest.mocked(h.logger.warn).mock.calls.filter(([event]) => event === 'chain_poll_saturated');
  expect(warnings).toHaveLength(3);
  expect(warnings[0][1]).toEqual(expect.objectContaining({ devices: 200,
    effectiveIntervalMs: expect.any(Number) }));
  expect((warnings[0][1] as { effectiveIntervalMs: number }).effectiveIntervalMs).toBeGreaterThan(60000);
  const summaries = jest.mocked(h.logger.info).mock.calls.filter(([event]) => event === 'chain_poll_summary');
  expect(summaries).toHaveLength(2);
  expect(summaries[0][1]).toEqual(expect.objectContaining({ devices: 200, queries: expect.any(Number),
    rows: 0, avgDurationMs: expect.any(Number), maxDurationMs: expect.any(Number), maxLagMs: null,
    throttledMs: expect.any(Number), effectiveIntervalMs: expect.any(Number) }));
  expect(jest.mocked(h.logger.debug).mock.calls.some(([event]) => event === 'chain_poll')).toBe(false);
  await h.limiter.close();
});

test('un equipo nuevo recibe el primer turno disponible', async () => {
  const h = fixture(0);
  await h.poller.run();
  h.add(1);
  h.setTime(1000);
  await h.poller.run();
  expect(h.timestamps.get(9001)).toEqual([1000]);
  await h.limiter.close();
});

test('hasMore vuelve a la cola tras los otros equipos vencidos', async () => {
  const h = fixture(2);
  h.setHasMoreOnce(9001);
  h.setTime(0); await h.poller.run();
  expect(h.timestamps.get(9001)).toEqual([0]);
  h.setTime(334); await h.poller.run();
  expect(h.timestamps.get(9002)).toEqual([334]);
  expect(h.timestamps.get(9001)).toEqual([0]);
  h.setTime(668); await h.poller.run();
  expect(h.timestamps.get(9001)).toEqual([0, 668]);
  await h.limiter.close();
});
