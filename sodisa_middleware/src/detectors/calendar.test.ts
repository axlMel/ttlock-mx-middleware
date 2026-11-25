import type { SqlClient } from '../db/types';
import type { ChainCursor } from '../persistence';
import { createChainReader, previousLabel, weekLabel, weekStartMs, type ChainAlert } from './index';
import { PARTITIONS_SQL, NAMESPACE_SQL } from './partitions';

const ms = (date: string): number => Date.parse(date);
const raw = Buffer.from('+ACK:GTGEO,0000$');
const row = (id: number, date: string) => ({ int_id: id, dt_trama: date, bytea_mensaje: raw });

test('etiquetas UTC reales y bordes de año', () => {
  const fixtures: Array<[string, string]> = [
    ['2025-12-10', '202550'], ['2025-12-31', '202553'], ['2026-01-01', '202601'],
    ['2026-11-05', '202645'], ['2026-11-19', '202647'], ['2026-11-24', '202647'],
    ['2026-11-26', '202648'], ['2026-12-31', '202653'], ['2027-01-01', '202701'],
    ['2028-12-29', '202852'], ['2028-12-30', '202853'], ['2028-12-31', '202853'],
    ['2030-12-31', '203053'], ['2031-01-01', '203101'],
  ];
  for (const [date, label] of fixtures) expect(weekLabel(ms(date + 'T12:00:00Z'))).toBe(label);
  expect(previousLabel('202601')).toBe('202553');
  expect(previousLabel('202647')).toBe('202646');
  expect(previousLabel('202701')).toBe('202653');
});

test('propiedad diaria 2025–2035: semanas contadas desde el 1 de enero', () => {
  const dayMs = 86_400_000;
  let previous = '';
  for (let day = ms('2025-01-01T00:00:00Z'); day <= ms('2035-12-31T00:00:00Z'); day += dayMs) {
    const label = weekLabel(day);
    expect(weekStartMs(label)).toBeLessThanOrEqual(day);
    expect(weekLabel(weekStartMs(label))).toBe(label);
    if (previous && label !== previous) {
      expect(label > previous).toBe(true);
      const sameYear = label.slice(0, 4) === previous.slice(0, 4);
      if (sameYear) expect(Number(label.slice(4))).toBe(Number(previous.slice(4)) + 1);
      else {
        expect(label.slice(4)).toBe('01');
        expect(new Date(day).getUTCMonth()).toBe(0);
        expect(new Date(day).getUTCDate()).toBe(1);
      }
      const duration = day - weekStartMs(previous);
      expect(Number(previous.slice(4)) === 53 ? [dayMs, 2 * dayMs] : [7 * dayMs]).toContain(duration);
    }
    previous = label;
  }
});

class FakeSql implements SqlClient {
  calls: Array<{ text: string; values: unknown[] }> = [];
  names = ['202646', '202647', '202648', '202649', '202650', '202651'];
  data = new Map<string, Array<Record<string, unknown>>>();
  unreadable = new Set<string>();
  async query(text: string, values: unknown[]) {
    this.calls.push({ text, values });
    if (text === NAMESPACE_SQL) return { rows: [{ oid: 1 }] };
    if (text === PARTITIONS_SQL) return { rows: this.names.map((relname) => ({ relname })) };
    const partition = /tbl_cadena\."([0-9]{6})"/.exec(text)?.[1];
    if (partition && this.unreadable.has(partition)) throw Object.assign(new Error('sin permiso'), { code: '42501' });
    if (text.includes('max(dt_trama)')) return { rows: [{ ultima: this.data.get(partition ?? '')?.at(-1)?.dt_trama ?? null }] };
    if (text.includes('SELECT int_id FROM')) return { rows: [] };
    return { rows: this.data.get(partition ?? '') ?? [] };
  }
  reads(): string[] {
    return this.calls.filter((call) => call.text.includes('bytea_mensaje'))
      .map((call) => /tbl_cadena\."([0-9]{6})"/.exec(call.text)![1]);
  }
}

function fixture(nowMs: number) {
  const db = new FakeSql();
  const alerts: ChainAlert[] = [];
  const selected: Array<{ partition: string; computed: string; fallback: boolean }> = [];
  let time = nowMs;
  const reader = createChainReader(db, { assignmentTz: 'UTC', chainBatchLimit: 2, chainOverlapMs: 0,
    now: () => time, onAlert: (alert) => alerts.push(alert), onPartitionSelected: (event) => selected.push(event) });
  return { db, reader, alerts, selected, setTime: (value: number) => { time = value; } };
}

test('catálogo precargado no mueve initCursor a una partición futura y P0 se ejecuta una vez', async () => {
  const h = fixture(ms('2026-11-24T12:00:00Z'));
  await Promise.all([h.reader.initCursor(1), h.reader.initCursor(2)]);
  await h.reader.initCursor(3);
  expect(h.db.calls.filter((call) => call.text === PARTITIONS_SQL)).toHaveLength(1);
  expect(h.db.calls.filter((call) => call.text.includes('tbl_cadena.')).every((call) => call.text.includes('"202647"'))).toBe(true);
  expect(h.selected).toEqual([{ partition: '202647', computed: '202647', fallback: false }]);
  expect(h.alerts).toEqual([]);
  expect((await h.reader.readNew(3, { partition: '202647', dtTrama: null, recentIds: [] })).frames).toEqual([]);
  expect(h.alerts).toEqual([]);
  expect(PARTITIONS_SQL).not.toMatch(/LIMIT|JOIN|SELECT\s+\*/i);
});

test('selección se registra una vez por nombre efectivo, incluso tras respaldos', async () => {
  const h = fixture(ms('2026-11-24T12:00:00Z'));
  h.db.names = ['202646', '202647'];
  await h.reader.initCursor(1);
  h.setTime(ms('2026-11-26T00:00:00Z'));
  await h.reader.initCursor(1);
  await h.reader.initCursor(2);
  expect(h.selected).toHaveLength(1);
  expect(h.alerts.filter((alert) => alert.code === 'PARTITION_NOT_FOUND')).toHaveLength(1);
  h.db.names.push('202648');
  h.setTime(ms('2026-11-26T00:01:00Z'));
  await h.reader.initCursor(1);
  expect(h.selected).toEqual([
    { partition: '202647', computed: '202647', fallback: false },
    { partition: '202648', computed: '202648', fallback: false },
  ]);
});

test('corte semanal conserva marcas independientes y no repite un frame entre sondeos', async () => {
  const h = fixture(ms('2026-11-26T00:00:10Z'));
  h.db.data.set('202647', [row(11, '2026-11-25 23:59:59.000001')]);
  h.db.data.set('202648', [row(12, '2026-11-26 00:00:01.000001')]);
  const start = { partition: '202647', dtTrama: '2026-11-25 23:59:58.000000', recentIds: [] };
  const first = await h.reader.readNew(1, start);
  expect(h.db.reads()).toEqual(['202647', '202648']);
  expect(first.frames.map((frame) => frame.frameId)).toEqual([11, 12]);
  expect(first.cursor).toMatchObject({ partition: '202648', dtTrama: '2026-11-26 00:00:01.000001',
    previous: { partition: '202647', dtTrama: '2026-11-25 23:59:59.000001' } });
  const second = await h.reader.readNew(1, first.cursor);
  expect(second.frames).toEqual([]);
  expect(h.db.reads()).toEqual(['202647', '202648', '202647', '202648']);
  h.setTime(ms('2026-11-26T00:06:00Z'));
  const late = await h.reader.readNew(1, second.cursor);
  expect(h.db.reads().at(-1)).toBe('202648');
  expect(late.cursor.previous).toBeUndefined();
});

test.each([
  ['202553', '202601', '2026-01-01T00:00:30Z'],
  ['202653', '202701', '2027-01-01T00:00:30Z'],
])('cambio de año %s a %s lee ambas particiones', async (oldLabel, newLabel, date) => {
  const h = fixture(ms(date));
  h.db.names = [oldLabel, newLabel];
  const result = await h.reader.readNew(1, { partition: oldLabel, dtTrama: '2025-12-31 23:59:59', recentIds: [] });
  expect(h.db.reads()).toEqual([oldLabel, newLabel]);
  expect(result.cursor.partition).toBe(newLabel);
  expect(result.cursor.previous?.partition).toBe(oldLabel);
});

test('initCursor en ventana doble jamás crea previous; marca antigua nula tampoco lee historial', async () => {
  const h = fixture(ms('2026-11-26T00:04:00Z'));
  h.db.data.set('202648', [row(12, '2026-11-26 00:00:01.000001')]);
  const init = await h.reader.initCursor(1);
  expect(init).not.toHaveProperty('previous');
  await h.reader.readNew(1, init);
  expect(h.db.reads()).toEqual(['202648']);
  h.db.calls = [];
  const crossed = await h.reader.readNew(1, { partition: '202647', dtTrama: null, recentIds: [] });
  expect(h.db.reads()).toEqual(['202648']);
  expect(crossed.cursor).not.toHaveProperty('previous');
});

test('lote anterior lleno se drena después de cinco minutos y conserva su marca', async () => {
  const h = fixture(ms('2026-11-26T00:00:10Z'));
  h.db.data.set('202647', [row(1, '2026-11-25 23:59:58.000001'), row(2, '2026-11-25 23:59:59.000001')]);
  const first = await h.reader.readNew(1, { partition: '202647', dtTrama: '2026-11-25 23:59:57', recentIds: [] });
  expect(first.hasMore).toBe(true);
  expect(first.cursor.previous).toMatchObject({ dtTrama: '2026-11-25 23:59:59.000001', hasMore: true });
  h.setTime(ms('2026-11-26T00:06:00Z'));
  h.db.data.set('202647', [row(3, '2026-11-25 23:59:59.000002')]);
  const second = await h.reader.readNew(1, first.cursor);
  expect(second.frames.map((frame) => frame.frameId)).toEqual([3]);
  expect(h.db.reads()).toEqual(['202647', '202648', '202647', '202648']);
  expect(second.cursor.previous).toBeUndefined();
});

test('42501 en la nueva conserva marca vieja; initCursor usa la mayor legible anterior', async () => {
  const h = fixture(ms('2026-11-26T00:00:10Z'));
  h.db.unreadable.add('202648');
  const start = { partition: '202647', dtTrama: '2026-11-25 23:59:58.000000', recentIds: [] };
  const read = await h.reader.readNew(1, start);
  expect(read.cursor.partition).toBe('202647');
  expect((await h.reader.initCursor(1)).partition).toBe('202647');
  expect(h.alerts.filter((alert) => alert.code === 'PARTITION_UNREADABLE')).toHaveLength(1);
  expect(h.selected).toEqual([{ partition: '202647', computed: '202648', fallback: true }]);
});

test('42501 después del cambio no retrocede la marca actual', async () => {
  const h = fixture(ms('2026-11-26T00:04:00Z'));
  const cursor: ChainCursor = { partition: '202648', dtTrama: '2026-11-26 00:00:01.000001', recentIds: [12],
    previous: { partition: '202647', dtTrama: '2026-11-25 23:59:59.000001', recentIds: [11], hasMore: false } };
  h.db.unreadable.add('202648');
  await expect(h.reader.readNew(1, cursor)).rejects.toMatchObject({ code: '42501' });
  expect(h.alerts.filter((alert) => alert.code === 'PARTITION_UNREADABLE')).toHaveLength(1);
  expect(cursor.partition).toBe('202648');
});
