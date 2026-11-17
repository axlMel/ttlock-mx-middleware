import type Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { RedisRouteStateStore } from './routeStateStore';
import { RedisChainCursorStore } from './chainCursorStore';
import { RedisCatalogCacheStore } from './catalogCacheStore';
import { routeKey, deviceRouteKey, chainCursorKey, catalogKey } from './keys';
import { CorruptStateError, type RouteState, type ChainCursor, type CatalogEntry, type FsmState } from './types';

const state: RouteState = {
  assignmentId: 42, companyId: 364, apiCompanyId: 2, unitId: 81,
  deviceId: 9001, model: 'GV300W', catalogRouteId: 17, routeType: 0,
  fsmState: 'AWAITING_ACK', currentPointId: 5, completedPointIds: [3],
  stepSeq: 2, transmissionSeq: 1, retryCount: 0,
  pendingRequest: { idempotencyKey: 'key-42', body: { companyId: 2, unitId: '81', comando: 'AT+GTGEO$' } },
  lastAcceptedCommand: 'AT+GTGEO$',
  ackDeadline: '2026-11-16T12:01:00.000Z', closing: null,
  startedAt: '2026-11-16T12:00:00.000Z', updatedAt: '2026-11-16T12:00:01.000Z',
};

let redis: Redis;
beforeEach(async () => {
  redis = new RedisMock();
  await redis.flushall();
});
afterEach(() => redis.disconnect());

test('guarda, enumera y borra rutas con su índice de dispositivo, sin TTL', async () => {
  const store = new RedisRouteStateStore(redis);
  expect(await store.get(42)).toBeNull();
  expect(await store.getByDevice(9001)).toBeNull();
  expect(await store.list()).toEqual([]);
  await store.set(state);
  expect(await store.get(42)).toEqual(state);
  expect(await store.getByDevice(9001)).toEqual(state);
  expect(await redis.get(deviceRouteKey(9001))).toBe('42');
  expect(await redis.ttl(routeKey(42))).toBe(-1);
  expect(await redis.ttl(deviceRouteKey(9001))).toBe(-1);
  await store.delete(42);
  expect(await store.get(42)).toBeNull();
  expect(await store.getByDevice(9001)).toBeNull();
  expect(await redis.get(deviceRouteKey(9001))).toBeNull();
});

test('list filtra llaves ajenas y conserva routeType', async () => {
  const store = new RedisRouteStateStore(redis);
  const second: RouteState = { ...state, assignmentId: 43, deviceId: 9002, routeType: 1 };
  await store.set(state);
  await store.set(second);
  await redis.set('route:invalid', JSON.stringify(state));
  await redis.set('device-route:999', '42');
  expect(await store.list()).toEqual(expect.arrayContaining([state, second]));
  expect((await store.list())).toHaveLength(2);
  expect((await store.get(43))?.routeType).toBe(1);
  await store.delete(42);
  expect(await store.list()).toEqual([second]);
});

test('set actualiza el índice cuando cambia el dispositivo', async () => {
  const store = new RedisRouteStateStore(redis);
  await store.set(state);
  await store.set({ ...state, deviceId: 9002 });
  expect(await store.getByDevice(9001)).toBeNull();
  expect((await store.getByDevice(9002))?.assignmentId).toBe(42);
});

test('getByDevice devuelve null si el índice apunta a ruta ausente', async () => {
  await redis.set(deviceRouteKey(9001), '42');
  expect(await new RedisRouteStateStore(redis).getByDevice(9001)).toBeNull();
});

test('RouteState antiguo sin lastAcceptedCommand se lee como null', async () => {
  const previous = { ...state } as Partial<RouteState>;
  delete previous.lastAcceptedCommand;
  await redis.set(routeKey(42), JSON.stringify(previous));
  const store = new RedisRouteStateStore(redis);
  await expect(store.get(42)).resolves.toEqual({ ...previous, lastAcceptedCommand: null });
});

test('JSON corrupto lanza en get y getByDevice; list avisa, omite y continúa', async () => {
  const onCorrupt = jest.fn();
  const store = new RedisRouteStateStore(redis, { onCorrupt });
  await store.set(state);
  await redis.set(routeKey(43), '{');
  await redis.set(deviceRouteKey(9002), '43');
  await expect(store.get(43)).rejects.toMatchObject({ name: 'CorruptStateError', key: routeKey(43) });
  await expect(store.getByDevice(9002)).rejects.toBeInstanceOf(CorruptStateError);
  expect(await store.list()).toEqual([state]);
  expect(onCorrupt).toHaveBeenCalledWith(routeKey(43), expect.any(CorruptStateError));
});

test('cursor por dispositivo guarda, lee y borra sin TTL', async () => {
  const store = new RedisChainCursorStore(redis);
  const cursor: ChainCursor = { partition: '202646', dtTrama: '2026-11-16 12:00:00.123456', recentIds: [1, 2] };
  expect(await store.get(9001)).toBeNull();
  await store.set(9001, cursor);
  expect(await store.get(9001)).toEqual(cursor);
  expect(await store.get(9002)).toBeNull();
  expect(await redis.ttl(chainCursorKey(9001))).toBe(-1);
  await store.delete(9001);
  expect(await store.get(9001)).toBeNull();
});

test('caché por entidad e id guarda, lee y borra sin TTL', async () => {
  const store = new RedisCatalogCacheStore(redis);
  const entry: CatalogEntry<{ radius: number }> = { value: { radius: 50 }, dtModificacion: null, fetchedAt: '2026-11-16T12:00:00.000Z' };
  expect(await store.get('site', 1)).toBeNull();
  await store.set('site', 1, entry);
  expect(await store.get<{ radius: number }>('site', 1)).toEqual(entry);
  expect(await store.get('route', 1)).toBeNull();
  expect(await redis.ttl(catalogKey('site', 1))).toBe(-1);
  await store.delete('site', 1);
  expect(await store.get('site', 1)).toBeNull();
});

test('FsmState excluye estados terminales de fallo y pausa', () => {
  // @ts-expect-error FAILED no pertenece a FsmState.
  const failed: FsmState = 'FAILED';
  // @ts-expect-error PAUSED no pertenece a FsmState.
  const paused: FsmState = 'PAUSED';
  expect([failed, paused]).not.toContain(state.fsmState);
});
