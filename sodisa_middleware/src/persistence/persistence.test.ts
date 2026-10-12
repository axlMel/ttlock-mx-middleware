import type Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { RedisPollingCursorStore } from './cursorStore';
import { RedisRouteStateStore } from './routeStateStore';
import type { RouteState } from './types';

const routeState: RouteState = {
  deviceId: '863457050476769',
  routeId: 'route-42',
  currentSiteIndex: 2,
  fsmState: 'AWAITING_ACK',
  lastCommandSentAt: '2026-09-21T22:09:39.000Z',
  retryCount: 1,
};

describe('RedisRouteStateStore', () => {
  let redis: Redis;
  let store: RedisRouteStateStore;

  beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
    store = new RedisRouteStateStore(redis);
  });

  afterEach(() => {
    redis.disconnect();
  });

  test('devuelve null cuando no hay ruta activa', async () => {
    await expect(store.get(routeState.deviceId)).resolves.toBeNull();
  });

  test('guarda y lee el mismo RouteState en la llave del dispositivo', async () => {
    await store.set(routeState.deviceId, routeState);

    await expect(store.get(routeState.deviceId)).resolves.toEqual(routeState);
    await expect(redis.get(`route:${routeState.deviceId}`)).resolves.toBe(JSON.stringify(routeState));
  });

  test('elimina el estado y el siguiente get devuelve null', async () => {
    await store.set(routeState.deviceId, routeState);
    await store.delete(routeState.deviceId);

    await expect(store.get(routeState.deviceId)).resolves.toBeNull();
  });

  test('no aplica TTL al estado de la ruta', async () => {
    await store.set(routeState.deviceId, routeState);

    await expect(redis.ttl(`route:${routeState.deviceId}`)).resolves.toBe(-1);
  });

  test('lista estados, ignora otras llaves y refleja eliminaciones', async () => {
    await expect(store.list()).resolves.toEqual([]);
    const pending: RouteState = {
      ...routeState,
      deviceId: '868589060960328',
      fsmState: 'PENDING',
      lastCommandSentAt: null,
      retryCount: 0,
    };
    await store.set(routeState.deviceId, routeState);
    await store.set(pending.deviceId, pending);
    await redis.set('cursor:reporte_cadenas', '4');

    await expect(store.list()).resolves.toEqual(expect.arrayContaining([routeState, pending]));
    expect((await store.list()).length).toBe(2);
    await store.delete(routeState.deviceId);
    await expect(store.list()).resolves.toEqual([pending]);
  });
});

describe('RedisPollingCursorStore', () => {
  let redis: Redis;
  let store: RedisPollingCursorStore;

  beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
    store = new RedisPollingCursorStore(redis);
  });

  afterEach(() => {
    redis.disconnect();
  });

  test('devuelve null para una fuente sin cursor', async () => {
    await expect(store.get('reporte_cadenas')).resolves.toBeNull();
  });

  test('guarda y lee el cursor como string plano por fuente', async () => {
    await store.set('reporte_cadenas', '12345');

    await expect(store.get('reporte_cadenas')).resolves.toBe('12345');
    await expect(redis.get('cursor:reporte_cadenas')).resolves.toBe('12345');
    await expect(store.get('otra_fuente')).resolves.toBeNull();
  });
});
