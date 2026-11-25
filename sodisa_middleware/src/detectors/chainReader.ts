import type { SqlClient } from '../db/types';
import type { ChainCursor, PartitionMark } from '../persistence';
import { toMicros } from './micros';
import { PARTITION_DUAL_READ_MS, Partitions, previousLabel, weekStartMs } from './partitions';
import type { ChainAlert, ChainFrame, ChainReader, DetectorOptions } from './types';

export const latestSql = (table: string): string => `SELECT max(dt_trama)::text AS ultima FROM ${table} WHERE int_iddispositivo = $1`;
export const overlapIdsSql = (table: string): string => `SELECT int_id FROM ${table} WHERE int_iddispositivo = $1 AND dt_trama >= $2::timestamp - $3 * interval '1 millisecond'`;
export const newSql = (table: string): string => `SELECT int_id, dt_trama::text AS dt_trama, bytea_mensaje FROM ${table} WHERE int_iddispositivo = $1 AND dt_trama >= $2::timestamp - $3 * interval '1 millisecond' ORDER BY dt_trama LIMIT $4`;
export const fromStartSql = (table: string): string => `SELECT int_id, dt_trama::text AS dt_trama, bytea_mensaje FROM ${table} WHERE int_iddispositivo = $1 ORDER BY dt_trama LIMIT $2`;

type Row = Record<string, unknown>;
type ReadResult = { mark: PartitionMark; frames: ChainFrame[]; hasMore: boolean };
const isUnreadable = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501';

export function createChainReader(db: SqlClient, opts: DetectorOptions): ChainReader {
  const now = opts.now ?? Date.now;
  const partitions = new Partitions(db, now, opts.onAlert, opts.onPartitionSelected);
  const unreadable = new Set<string>();
  const alert = (code: ChainAlert['code'], partition: string, message: string): void => opts.onAlert?.({ code, partition, message });
  const alertUnreadable = (partition: string): void => {
    if (!unreadable.has(partition)) alert('PARTITION_UNREADABLE', partition, `Sin permiso de lectura en partición ${partition}.`);
    unreadable.add(partition);
  };
  const query = async (text: string, values: unknown[], partition: string): Promise<Row[]> => {
    try {
      const result = await db.query(text, values);
      return result.rows;
    } catch (error) {
      if (isUnreadable(error)) alertUnreadable(partition);
      throw error;
    }
  };
  const read = async (deviceId: number, mark: PartitionMark): Promise<ReadResult> => {
    const table = partitions.quote(mark.partition);
    const rows = mark.dtTrama === null
      ? await query(fromStartSql(table), [deviceId, opts.chainBatchLimit], mark.partition)
      : await query(newSql(table), [deviceId, mark.dtTrama, opts.chainOverlapMs, opts.chainBatchLimit], mark.partition);
    const hasMore = rows.length === opts.chainBatchLimit;
    if (!rows.length) return { mark: { partition: mark.partition, dtTrama: mark.dtTrama, recentIds: mark.recentIds }, frames: [], hasMore: false };
    const seen = new Set(mark.recentIds);
    const fresh = rows.filter((row) => !seen.has(Number(row.int_id)));
    if (hasMore && !fresh.length) {
      alert('CHAIN_WINDOW_SATURATED', mark.partition, `Ventana saturada en partición ${mark.partition}, dispositivo ${deviceId}.`);
      return { mark: { partition: mark.partition, dtTrama: mark.dtTrama, recentIds: mark.recentIds }, frames: [], hasMore };
    }
    const latest = rows.reduce((best, row) => toMicros(String(row.dt_trama)) > toMicros(best) ? String(row.dt_trama) : best,
      mark.dtTrama ?? String(rows[0].dt_trama));
    const threshold = toMicros(latest) - BigInt(opts.chainOverlapMs) * 1000n;
    const recentIds = [...new Set([
      ...(mark.dtTrama && toMicros(mark.dtTrama) >= threshold ? mark.recentIds : []),
      ...rows.filter((row) => toMicros(String(row.dt_trama)) >= threshold).map((row) => Number(row.int_id)),
    ])];
    const frames = fresh.map((row) => ({ frameId: Number(row.int_id), deviceId, receivedAt: String(row.dt_trama), raw: row.bytea_mensaje as Buffer }));
    return { mark: { partition: mark.partition, dtTrama: latest, recentIds }, frames, hasMore };
  };
  const combined = (first: ReadResult | null, second: ReadResult): ChainFrame[] => {
    const seen = new Set<number>();
    return [...(first?.frames ?? []), ...second.frames]
      .sort((a, b) => toMicros(a.receivedAt) < toMicros(b.receivedAt) ? -1 : toMicros(a.receivedAt) > toMicros(b.receivedAt) ? 1 : a.frameId - b.frameId)
      .filter((frame) => { if (seen.has(frame.frameId)) return false; seen.add(frame.frameId); return true; });
  };

  return {
    async initCursor(deviceId) {
      const selection = await partitions.resolveCurrent();
      let partition: string | null = selection.partition;
      while (partition) {
        try {
          const table = partitions.quote(partition);
          const latest = (await query(latestSql(table), [deviceId], partition))[0]?.ultima;
          const dtTrama = latest === null || latest === undefined ? null : String(latest);
          const recentIds = dtTrama === null ? [] : (await query(overlapIdsSql(table),
            [deviceId, dtTrama, opts.chainOverlapMs], partition)).map((row) => Number(row.int_id));
          partitions.select({ partition, computed: selection.computed, fallback: partition !== selection.computed });
          return { partition, dtTrama, recentIds };
        } catch (error) {
          if (!isUnreadable(error)) throw error;
          partition = partitions.previousKnown(partition);
        }
      }
      throw new Error(`No hay particiones legibles para el dispositivo ${deviceId}.`);
    },
    async readNew(deviceId, cursor) {
      const selection = await partitions.resolveCurrent();
      const current = selection.partition;
      if (cursor.partition > current) {
        const result = await read(deviceId, cursor);
        partitions.select({ partition: cursor.partition, computed: selection.computed, fallback: true });
        return { frames: result.frames, cursor: { ...result.mark, previous: cursor.previous }, hasMore: result.hasMore };
      }
      if (cursor.partition < current) {
        // Una marca nula en la semana anterior no autoriza C1b sobre todo su historial.
        const old = cursor.dtTrama === null ? null : await read(deviceId, cursor);
        let next: ReadResult;
        try { next = await read(deviceId, { partition: current, dtTrama: null, recentIds: [] }); }
        catch (error) {
          if (!isUnreadable(error)) throw error;
          if (old) partitions.select({ partition: old.mark.partition, computed: selection.computed, fallback: true });
          return old ? { frames: old.frames, cursor: { ...old.mark }, hasMore: old.hasMore }
            : { frames: [], cursor, hasMore: false };
        }
        partitions.select(selection);
        return { frames: combined(old, next),
          cursor: { ...next.mark, ...(old ? { previous: { ...old.mark, hasMore: old.hasMore } } : {}) },
          hasMore: (old?.hasMore ?? false) || next.hasMore };
      }
      const previous = cursor.previous;
      const withinWindow = now() - weekStartMs(current) < PARTITION_DUAL_READ_MS;
      const usePrevious = previous && previous.partition === previousLabel(current) &&
        (withinWindow || previous.hasMore) && previous.dtTrama !== null && partitions.has(previous.partition);
      const old = usePrevious ? await read(deviceId, previous) : null;
      const next = await read(deviceId, cursor);
      partitions.select(selection);
      const keepPrevious = old && (withinWindow || old.hasMore);
      const resultCursor: ChainCursor = old || previous ? { ...next.mark, ...(keepPrevious ? { previous: { ...old!.mark, hasMore: old!.hasMore } } : {}) }
        : next.mark;
      return { frames: combined(old, next), cursor: resultCursor, hasMore: (old?.hasMore ?? false) || next.hasMore };
    },
  };
}
