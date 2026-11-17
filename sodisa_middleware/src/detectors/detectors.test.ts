import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlClient } from '../db/types';
import { decodeFrame } from '../protocol';
import { assignment, frame } from './__fixtures__/rows';
import { ASSIGNMENT_SQL, ASSIGNMENTS_SQL } from './assignmentDetector';
import { fromStartSql, latestSql, newSql, overlapIdsSql } from './chainReader';
import { toMicros } from './micros';
import { NAMESPACE_SQL, PARTITIONS_SQL, Partitions } from './partitions';
import { createAssignmentDetector, createChainReader, type ChainAlert, type DetectorOptions } from './index';

const raw = Buffer.from(readFileSync(join(__dirname, '../protocol/__fixtures__/gv300w-ack.txt'), 'utf8').trim());
const t0 = '2026-11-17 12:00:00.000000';
const t1 = '2026-11-17 12:00:00.000001';

class FakeSql implements SqlClient {
  calls: { text: string; values: unknown[] }[] = [];
  partitions = ['202647', '202646'];
  rows: Record<string, Record<string, unknown>[]> = {};
  unreadable = new Set<string>();
  async query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ text, values });
    if (text === NAMESPACE_SQL) return { rows: [{ oid: 77 }] };
    if (text === PARTITIONS_SQL) return { rows: this.partitions.map((relname) => ({ relname })) };
    const partition = /tbl_cadena\."([0-9]{6})"/.exec(text)?.[1];
    if (partition && this.unreadable.has(partition)) throw Object.assign(new Error('Sin permiso'), { code: '42501' });
    return { rows: this.rows[text] ?? [] };
  }
}

const options = (alerts: ChainAlert[], now: () => number = () => 0): DetectorOptions => ({
  assignmentTz: 'UTC', chainBatchLimit: 2, chainOverlapMs: 10_000,
  partitionRefreshMs: 1000, now, onAlert: (alert) => alerts.push(alert),
});
const table = (partition: string) => `tbl_cadena."${partition}"`;

test('A1 y A2 tipan filas y pasan zona no UTC como segundo parámetro', async () => {
  const db = new FakeSql();
  db.rows[ASSIGNMENTS_SQL] = [assignment];
  db.rows[ASSIGNMENT_SQL] = [{ ...assignment, int_estado: 4, bol_enuso: false }];
  const detector = createAssignmentDetector(db, { assignmentTz: 'America/Mexico_City' });
  expect((await detector.listVigentes(364))[0]).toMatchObject({ assignmentId: 1410255, companyId: 364, unitId: 224979, horaInicial: assignment.dt_hora_inicial });
  expect((await detector.getById(1410255))?.estado).toBe(4);
  expect(db.calls.map((call) => call.values)).toEqual([[364, 'America/Mexico_City'], [1410255, 'America/Mexico_City']]);
  expect(ASSIGNMENTS_SQL).toContain('AT TIME ZONE $2');
  expect(assignment.dt_hora_inicial.toISOString()).toBe('2026-11-17T12:00:00.000Z');
  db.rows[ASSIGNMENT_SQL] = [];
  expect(await detector.getById(1)).toBeNull();
  db.rows[ASSIGNMENT_SQL] = [{ ...assignment, int_id: 'abc' }];
  await expect(detector.getById(1)).rejects.toThrow('abc');
});

test('microsegundos acepta 0 a 6 decimales y distingue 1 µs', () => {
  expect(toMicros(t1) - toMicros(t0)).toBe(1n);
  expect(toMicros('2026-11-17 12:00:00.1') - toMicros(t0)).toBe(100_000n);
  expect(toMicros('2026-11-17 12:00:00.123456') - toMicros(t0)).toBe(123_456n);
  expect(() => toMicros('incorrecto')).toThrow();
});

test('P0 cachea nombres y alerta una partición desaparecida', async () => {
  const db = new FakeSql();
  const alerts: ChainAlert[] = [];
  let time = 0;
  const partitions = new Partitions(db, 1000, () => time, (alert) => alerts.push(alert));
  expect(await partitions.current()).toEqual(['202647', '202646']);
  await partitions.current();
  expect(db.calls).toHaveLength(2);
  db.partitions = ['202648', '202647'];
  time = 1000;
  await partitions.current();
  expect(alerts).toContainEqual(expect.objectContaining({ code: 'PARTITION_DISAPPEARED', partition: '202646' }));
  expect(() => partitions.quote('202647;DROP')).toThrow();
  db.partitions = ['202649;DROP'];
  time = 2000;
  await expect(partitions.current()).rejects.toThrow('inválido');
});

test('initCursor lee C0 y C0b; sin tramas usa null; 42501 cae a la anterior', async () => {
  const db = new FakeSql();
  const alerts: ChainAlert[] = [];
  db.rows[latestSql(table('202647'))] = [{ ultima: t1 }];
  db.rows[overlapIdsSql(table('202647'))] = [{ int_id: 1 }, { int_id: 2 }];
  const reader = createChainReader(db, options(alerts));
  expect(await reader.initCursor(70177)).toEqual({ partition: '202647', dtTrama: t1, recentIds: [1, 2] });
  expect(db.calls.at(-1)?.values).toEqual([70177, t1, 10_000]);
  db.unreadable.add('202647');
  expect(await reader.initCursor(70177)).toEqual({ partition: '202646', dtTrama: null, recentIds: [] });
  expect(alerts.filter((alert) => alert.code === 'PARTITION_UNREADABLE')).toHaveLength(1);
  db.unreadable.add('202646');
  await expect(reader.initCursor(70177)).rejects.toThrow('No hay particiones');
});

test('readNew deduplica, conserva ids de ventana y entrega Buffer', async () => {
  const db = new FakeSql();
  const reader = createChainReader(db, options([]));
  const cursor = { partition: '202647', dtTrama: t0, recentIds: [1] };
  db.rows[newSql(table('202647'))] = [frame(1, t0, raw), frame(2, t1, raw)];
  const result = await reader.readNew(70177, cursor);
  expect(result.frames.map((item) => item.frameId)).toEqual([2]);
  expect(result.cursor).toEqual({ partition: '202647', dtTrama: t1, recentIds: [1, 2] });
  expect(result.hasMore).toBe(true);
  expect(Buffer.isBuffer(result.frames[0].raw)).toBe(true);
  expect(decodeFrame(result.frames[0].raw)).toContain('+ACK:GTGEO');
  expect(db.calls.at(-1)?.values).toEqual([70177, t0, 10_000, 2]);
});

test('lote lleno duplicado no avanza y emite CHAIN_WINDOW_SATURATED', async () => {
  const db = new FakeSql();
  const alerts: ChainAlert[] = [];
  const reader = createChainReader(db, options(alerts));
  const cursor = { partition: '202647', dtTrama: t1, recentIds: [1, 2] };
  db.rows[newSql(table('202647'))] = [frame(1, t0, raw), frame(2, t1, raw)];
  const result = await reader.readNew(70177, cursor);
  expect(result).toEqual({ frames: [], cursor, hasMore: true });
  expect(alerts).toContainEqual(expect.objectContaining({ code: 'CHAIN_WINDOW_SATURATED' }));
});

test('ventana de 0 ms distingue filas separadas por 1 µs', async () => {
  const db = new FakeSql();
  const reader = createChainReader(db, { ...options([]), chainOverlapMs: 0 });
  db.rows[fromStartSql(table('202647'))] = [frame(1, t0, raw), frame(2, t1, raw)];
  const result = await reader.readNew(70177, { partition: '202647', dtTrama: null, recentIds: [] });
  expect(result.cursor.recentIds).toEqual([2]);
  expect(result.hasMore).toBe(true);
});

test('cambio de partición lee C1b; 42501 mantiene cursor y alerta una vez', async () => {
  const db = new FakeSql();
  const alerts: ChainAlert[] = [];
  const reader = createChainReader(db, options(alerts));
  const cursor = { partition: '202646', dtTrama: t0, recentIds: [1] };
  db.unreadable.add('202647');
  expect((await reader.readNew(70177, cursor)).cursor).toBe(cursor);
  expect((await reader.readNew(70177, cursor)).cursor).toBe(cursor);
  expect(alerts.filter((alert) => alert.code === 'PARTITION_UNREADABLE')).toHaveLength(1);
  db.unreadable.delete('202647');
  db.rows[fromStartSql(table('202647'))] = [frame(3, t1, raw)];
  expect((await reader.readNew(70177, cursor)).cursor).toEqual({ partition: '202647', dtTrama: t1, recentIds: [3] });
});

test('SQL de detectores evita JOIN y SELECT *', () => {
  for (const query of [ASSIGNMENT_SQL, ASSIGNMENTS_SQL, NAMESPACE_SQL, PARTITIONS_SQL,
    latestSql(table('202647')), overlapIdsSql(table('202647')), newSql(table('202647')), fromStartSql(table('202647'))]) {
    expect(query).not.toMatch(/\bJOIN\b|SELECT\s+\*/i);
  }
});
