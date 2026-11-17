import type Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { RedisCatalogCacheStore } from '../persistence/catalogCacheStore';
import { device, points, route, sites, unit, unorderedRoute } from './__fixtures__/rows';
import { PgDeviceDirectory, PgRoutePlanRepository, UnknownModelError, UnitValidationError, InvalidPlanError, type SqlClient } from './index';
import { UNIT_SQL, DEVICE_SQL } from './deviceDirectory';
import { ROUTE_SQL, POINTS_SQL, SITE_SQL } from './routePlanRepository';
import { modelFor } from './modelMap';

class FakeSql implements SqlClient {
  calls: { text: string; values: unknown[] }[] = [];
  units: Record<string, unknown>[] = [{ ...unit }];
  devices: Record<string, unknown>[] = [{ ...device }];
  routes: Record<string, unknown>[] = [{ ...route }, { ...unorderedRoute }];
  points: Record<string, unknown>[] = points.map((row) => ({ ...row }));
  sites: Record<string, unknown>[] = sites.map((row) => ({ ...row }));

  async query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ text, values });
    if (text === UNIT_SQL) return { rows: this.units.filter((row) => row.int_id === values[0]) };
    if (text === DEVICE_SQL) return { rows: this.devices.filter((row) => row.int_id === values[0]) };
    if (text === ROUTE_SQL) return { rows: this.routes.filter((row) => row.int_id === values[0]) };
    if (text === POINTS_SQL) return { rows: this.points.filter((row) => row.int_idempresa === values[0] && row.int_idruta === values[1]) };
    if (text === SITE_SQL) return { rows: this.sites.filter((row) => row.int_id === values[0]) };
    throw new Error(`Consulta inesperada: ${text}`);
  }
}

let sql: FakeSql;
let redis: Redis;
let cache: RedisCatalogCacheStore;
beforeEach(async () => {
  sql = new FakeSql();
  redis = new RedisMock();
  await redis.flushall();
  cache = new RedisCatalogCacheStore(redis);
});
afterEach(() => redis.disconnect());

test('mapa de modelos admite 25 y 100 y rechaza otros', () => {
  expect(modelFor(25, 70177)).toBe('GV300W');
  expect(modelFor(100, 70177)).toBe('GV310LAU');
  expect(() => modelFor(999, 70177)).toThrow(UnknownModelError);
});

test('resuelve ambos modelos con U1 y U2 sin caché', async () => {
  const directory = new PgDeviceDirectory(sql);
  expect(await directory.resolveForRouteStart(224979, 364)).toEqual({ unitId: 224979, companyId: 364, deviceId: 70177, modelId: 25, model: 'GV300W' });
  sql.devices[0].int_idmodelo_dispositivo = '100';
  expect((await directory.resolveForRouteStart(224979, 364)).model).toBe('GV310LAU');
  expect(sql.calls.map((call) => call.values)).toEqual([[224979], [70177], [224979], [70177]]);
});

test('rechaza unidad y dispositivo inexistentes, inactivos y empresa distinta', async () => {
  const directory = new PgDeviceDirectory(sql);
  await expect(directory.resolveForRouteStart(999, 364)).rejects.toBeInstanceOf(UnitValidationError);
  sql.units[0].bol_enuso = false;
  await expect(directory.resolveForRouteStart(224979, 364)).rejects.toBeInstanceOf(UnitValidationError);
  sql.units[0].bol_enuso = true;
  await expect(directory.resolveForRouteStart(224979, 999)).rejects.toBeInstanceOf(UnitValidationError);
  sql.devices = [];
  await expect(directory.resolveForRouteStart(224979, 364)).rejects.toBeInstanceOf(UnitValidationError);
  sql.devices = [{ ...device, bol_enuso: false }];
  await expect(directory.resolveForRouteStart(224979, 364)).rejects.toBeInstanceOf(UnitValidationError);
  sql.devices[0].int_idmodelo_dispositivo = 999;
  sql.devices[0].bol_enuso = true;
  await expect(directory.resolveForRouteStart(224979, 364)).rejects.toBeInstanceOf(UnknownModelError);
});

test('plan ordenado consulta R1, P1 y S1, ordena y ajusta radio con aviso', async () => {
  const notices: string[] = [];
  const repository = new PgRoutePlanRepository(sql, cache, { onNotice: (message) => notices.push(message) });
  const plan = await repository.getPlan(364, 1410255);
  expect(plan.routeType).toBe(0);
  expect(plan.points.map((point) => point.pointId)).toEqual([3001, 3002, 3003]);
  expect(plan.points[0]).toEqual({ pointId: 3001, order: 1, siteId: 1389019, latitude: 19.355383, longitude: -99.128206, radiusM: 50, radiusAdjusted: true });
  expect(notices).toContainEqual(expect.stringContaining('Radio ajustado'));
  expect(sql.calls.map((call) => call.text)).toEqual([ROUTE_SQL, POINTS_SQL, SITE_SQL, SITE_SQL, SITE_SQL]);
});

test('ruta tipo 1 omite puntos y sitios', async () => {
  expect(await new PgRoutePlanRepository(sql, cache).getPlan(364, 1410256)).toEqual({ routeType: 1, points: [] });
  expect(sql.calls.map((call) => call.text)).toEqual([ROUTE_SQL]);
});

test('ruta inexistente, de otra empresa o tipo inválido falla', async () => {
  const repository = new PgRoutePlanRepository(sql, cache);
  await expect(repository.getPlan(364, 999)).rejects.toBeInstanceOf(InvalidPlanError);
  await expect(repository.getPlan(999, 1410255)).rejects.toBeInstanceOf(InvalidPlanError);
  sql.routes[0].int_tipo = 2;
  await expect(repository.getPlan(364, 1410255, { forceFresh: true })).rejects.toBeInstanceOf(InvalidPlanError);
  sql.routes[0].int_tipo = null;
  await expect(repository.getPlan(364, 1410255, { forceFresh: true })).rejects.toBeInstanceOf(InvalidPlanError);
});

test('filtra puntos inactivos y rechaza plan vacío', async () => {
  sql.points.forEach((point) => { point.bol_enuso = false; });
  await expect(new PgRoutePlanRepository(sql, cache).getPlan(364, 1410255)).rejects.toThrow('sin puntos');
});

test.each([
  ['int_radio', 7_000_000], ['int_radio', null], ['int_radio', 'desconocido'],
  ['latitud', 91], ['latitud', NaN], ['longitud', -181], ['longitud', 'desconocido'],
] as const)('rechaza sitio con %s inválido', async (field, value) => {
  sql.sites[0][field] = value;
  await expect(new PgRoutePlanRepository(sql, cache).getPlan(364, 1410255)).rejects.toBeInstanceOf(InvalidPlanError);
});

test('sitio inexistente o inactivo informa ids', async () => {
  const repository = new PgRoutePlanRepository(sql, cache);
  sql.sites = sql.sites.filter((site) => site.int_id !== 1389019);
  await expect(repository.getPlan(364, 1410255)).rejects.toThrow(/1389019.*3001/);
  sql.sites = [{ ...sites[0], bol_enuso: false }, ...sites.slice(1)];
  await expect(repository.getPlan(364, 1410255, { forceFresh: true })).rejects.toThrow(/1389019.*3001/);
});

test('caché joven evita SQL; forceFresh consulta las tres entidades', async () => {
  let time = new Date('2026-11-16T00:00:00Z');
  const repository = new PgRoutePlanRepository(sql, cache, { now: () => time, revalidateMs: 300_000 });
  await repository.getPlan(364, 1410255);
  sql.calls = [];
  time = new Date('2026-11-16T00:01:00Z');
  await repository.getPlan(364, 1410255);
  expect(sql.calls).toHaveLength(0);
  await repository.getPlan(364, 1410255, { forceFresh: true });
  expect(sql.calls).toHaveLength(5);
});

test('caché vieja detecta cambio y renueva fetchedAt', async () => {
  let time = new Date('2026-11-16T00:00:00Z');
  const notices: string[] = [];
  const repository = new PgRoutePlanRepository(sql, cache, { now: () => time, revalidateMs: 300_000, onNotice: (message) => notices.push(message) });
  await repository.getPlan(364, 1410255);
  sql.sites[0].int_radio = 80;
  time = new Date('2026-11-16T00:06:00Z');
  expect((await repository.getPlan(364, 1410255)).points[0].radiusM).toBe(80);
  expect(notices).toContain('Cambio detectado en site 1389019');
  expect((await cache.get('site', 1389019))?.fetchedAt).toBe(time.toISOString());
});

test('caché vieja sin cambios solo renueva fetchedAt', async () => {
  let time = new Date('2026-11-16T00:00:00Z');
  const notices: string[] = [];
  const repository = new PgRoutePlanRepository(sql, cache, { now: () => time, revalidateMs: 300_000, onNotice: (message) => notices.push(message) });
  await repository.getPlan(364, 1410255);
  notices.length = 0;
  sql.calls = [];
  time = new Date('2026-11-16T00:06:00Z');
  await repository.getPlan(364, 1410255);
  expect(sql.calls).toHaveLength(5);
  expect(notices).not.toContainEqual(expect.stringContaining('Cambio detectado'));
  expect((await cache.get('route', 1410255))?.fetchedAt).toBe(time.toISOString());
});

test('las cinco consultas son parametrizadas y no usan JOIN ni SELECT *', () => {
  for (const query of [UNIT_SQL, DEVICE_SQL, ROUTE_SQL, POINTS_SQL, SITE_SQL]) {
    expect(query).not.toMatch(/\bJOIN\b|SELECT\s+\*/i);
    expect(query).toMatch(/\$1/);
    expect(query).toMatch(/\bWHERE\b/i);
  }
});
