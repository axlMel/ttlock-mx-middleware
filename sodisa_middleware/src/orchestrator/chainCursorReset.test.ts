import type { ChainCursor, RouteState, RouteStateStore, ChainCursorStore } from '../persistence';
import { PartitionNotKnownError } from '../detectors';
import { createChainQueryLimiter } from './chainQueryLimiter';
import { ChainPoller } from './chainPoller';
import { KeyedMutex } from './keyedMutex';
import type { StepRunner } from './stepRunner';
import type { OrchestratorDeps, OrchestratorOptions } from './types';

const now = Date.parse('2026-11-24T12:00:00Z');
const future: ChainCursor = { partition: '202651', dtTrama: null, recentIds: [] };
const current: ChainCursor = { partition: '202647', dtTrama: null, recentIds: [] };
const state: RouteState = {
  assignmentId: 42, companyId: 364, apiCompanyId: 2, unitId: 81, deviceId: 9001, model: 'GV300W',
  catalogRouteId: 17, routeType: 0, fsmState: 'AWAITING_ACK', currentPointId: 3,
  completedPointIds: [1, 2], stepSeq: 2, transmissionSeq: 1, retryCount: 0, pendingRequest: null,
  lastAcceptedCommand: 'AT+GTGEO', firstTransmissionAt: '2026-11-18T11:00:00Z',
  ackDeadline: '2026-11-24T12:03:00Z', closing: null,
  startedAt: '2026-11-10T11:00:00Z', updatedAt: '2026-11-24T12:00:00Z',
};

function fixture(route: RouteState) {
  let cursor = future;
  const reads: ChainCursor[] = [];
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const routeStates: RouteStateStore = {
    get: async () => route, getByDevice: async () => route, set: async () => undefined,
    delete: async () => undefined, list: async () => [route],
  };
  const cursors: ChainCursorStore = {
    get: async () => cursor, set: async (_id, value) => { cursor = value; },
    delete: async () => undefined,
  };
  const initCursor = jest.fn(async () => current);
  const readNew = jest.fn(async (_id: number, mark: ChainCursor) => {
    reads.push(mark);
    return { frames: [], cursor: mark, hasMore: false };
  });
  const limiter = createChainQueryLimiter(3, () => now);
  const opts: OrchestratorOptions = { enabledCompanies: new Map([[364, 2]]), pollIntervalMsRoutes: 10000,
    chainPollIntervalMs: 60000, chainMaxQueriesPerSecond: 3, ackRetryBackoffMs: 180000,
    ackMaxRetries: 3, ackResendEnabled: true, dryRun: false, now: () => now };
  const deps = { routeStates, cursors, chainQueryLimiter: limiter, logger,
    detectors: { chains: { initCursor, readNew }, assignments: { listVigentes: jest.fn(), getById: jest.fn() } },
    catalog: {}, gateway: {}, scheduler: {} } as unknown as OrchestratorDeps;
  const poller = new ChainPoller(deps, opts, new Map(), { resendAfterRead: async () => undefined } as unknown as StepRunner, new KeyedMutex());
  return { poller, reads, logger, initCursor, readNew, limiter, getCursor: () => cursor };
}

test('cursor futuro se reancla a la primera transmisión del paso, nunca al inicio de ruta', async () => {
  const h = fixture(state);
  await h.poller.run();
  expect(h.reads).toEqual([{ partition: '202646', dtTrama: '2026-11-18 11:00:00.000', recentIds: [] }]);
  expect(h.getCursor()).toEqual(h.reads[0]);
  expect(h.logger.warn).toHaveBeenCalledWith('chain_cursor_reset', expect.objectContaining({ anchor: 'transmission' }));
  await h.limiter.close();
});

test('sin primera transmisión AWAITING_ACK deriva la última desde ackDeadline', async () => {
  const h = fixture({ ...state, firstTransmissionAt: null });
  await h.poller.run();
  expect(h.reads[0]).toEqual({ partition: '202647', dtTrama: '2026-11-24 12:00:00.000', recentIds: [] });
  await h.limiter.close();
});

test('startedAt solo sirve para stepSeq 0; paso posterior sin ancla hace init sin frames', async () => {
  const old = { ...state, firstTransmissionAt: null, ackDeadline: null };
  const h = fixture(old);
  await h.poller.run();
  expect(h.initCursor).toHaveBeenCalledTimes(1);
  expect(h.readNew).not.toHaveBeenCalled();
  expect(h.getCursor()).toEqual(current);
  expect(h.logger.warn).toHaveBeenCalledWith('chain_cursor_reset', expect.objectContaining({ anchor: 'init' }));
  await h.limiter.close();
  const first = fixture({ ...old, stepSeq: 0 });
  await first.poller.run();
  expect(first.reads[0].partition).toBe('202645');
  expect(first.initCursor).not.toHaveBeenCalled();
  await first.limiter.close();
});

test('ancla fuera del catálogo usa init sin ocultar fallos de BD', async () => {
  const h = fixture(state);
  h.readNew.mockRejectedValueOnce(new PartitionNotKnownError('202646'));
  await h.poller.run();
  expect(h.initCursor).toHaveBeenCalledTimes(1);
  expect(h.getCursor()).toEqual(current);
  expect(h.logger.warn).toHaveBeenCalledWith('chain_cursor_reset', expect.objectContaining({ anchor: 'init' }));
  await h.limiter.close();
  const failure = fixture(state);
  failure.readNew.mockRejectedValueOnce(new Error('BD indisponible'));
  await failure.poller.run();
  expect(failure.initCursor).not.toHaveBeenCalled();
  expect(failure.logger.error).toHaveBeenCalledWith('chain_poll_failed', expect.objectContaining({ errorMessage: 'BD indisponible' }));
  await failure.limiter.close();
});
