import type { SqlClient } from '../db/types';
import type { ChainCursor } from '../persistence/types';
import { toMicros } from './micros';
import { Partitions } from './partitions';
import type { ChainAlert, ChainFrame, ChainReader, DetectorOptions } from './types';

export const latestSql = (table: string): string => `SELECT max(dt_trama)::text AS ultima FROM ${table} WHERE int_iddispositivo = $1`;
export const overlapIdsSql = (table: string): string => `SELECT int_id FROM ${table} WHERE int_iddispositivo = $1 AND dt_trama >= $2::timestamp - $3 * interval '1 millisecond'`;
export const newSql = (table: string): string => `SELECT int_id, dt_trama::text AS dt_trama, bytea_mensaje FROM ${table} WHERE int_iddispositivo = $1 AND dt_trama >= $2::timestamp - $3 * interval '1 millisecond' ORDER BY dt_trama LIMIT $4`;
export const fromStartSql = (table: string): string => `SELECT int_id, dt_trama::text AS dt_trama, bytea_mensaje FROM ${table} WHERE int_iddispositivo = $1 ORDER BY dt_trama LIMIT $2`;

type Row = Record<string, unknown>;
const isUnreadable = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501';

export function createChainReader(db: SqlClient, opts: DetectorOptions): ChainReader {
  const now = opts.now ?? Date.now;
  const partitions = new Partitions(db, opts.partitionRefreshMs, now, opts.onAlert);
  const unreadable = new Set<string>();
  const alert = (code: ChainAlert['code'], partition: string, message: string): void => opts.onAlert?.({ code, partition, message });
  const alertUnreadable = (partition: string): void => {
    if (!unreadable.has(partition)) alert('PARTITION_UNREADABLE', partition, `Sin permiso de lectura en partición ${partition}.`);
    unreadable.add(partition);
  };
  const query = async (text: string, values: unknown[], partition: string): Promise<Row[]> => {
    try {
      const result = await db.query(text, values);
      unreadable.delete(partition);
      return result.rows;
    } catch (error) {
      if (isUnreadable(error)) alertUnreadable(partition);
      throw error;
    }
  };
  const read = async (deviceId: number, partition: string, dtTrama: string | null): Promise<Row[]> => {
    const table = partitions.quote(partition);
    return dtTrama === null
      ? query(fromStartSql(table), [deviceId, opts.chainBatchLimit], partition)
      : query(newSql(table), [deviceId, dtTrama, opts.chainOverlapMs, opts.chainBatchLimit], partition);
  };
  const process = (deviceId: number, cursor: ChainCursor, rows: Row[]): { frames: ChainFrame[]; cursor: ChainCursor; hasMore: boolean } => {
    const hasMore = rows.length === opts.chainBatchLimit;
    if (rows.length === 0) return { frames: [], cursor, hasMore: false };
    const seen = new Set(cursor.recentIds);
    const fresh = rows.filter((row) => !seen.has(Number(row.int_id)));
    if (hasMore && fresh.length === 0) {
      alert('CHAIN_WINDOW_SATURATED', cursor.partition, `Ventana saturada en partición ${cursor.partition}, dispositivo ${deviceId}.`);
      return { frames: [], cursor, hasMore };
    }
    const latest = rows.reduce((best, row) => toMicros(String(row.dt_trama)) > toMicros(best) ? String(row.dt_trama) : best, String(rows[0].dt_trama));
    const threshold = toMicros(latest) - BigInt(opts.chainOverlapMs) * 1000n;
    const recentIds = [...new Set(rows.filter((row) => toMicros(String(row.dt_trama)) >= threshold).map((row) => Number(row.int_id)))];
    const frames = fresh.map((row) => ({ frameId: Number(row.int_id), deviceId, receivedAt: String(row.dt_trama), raw: row.bytea_mensaje as Buffer }));
    return { frames, cursor: { partition: cursor.partition, dtTrama: latest, recentIds }, hasMore };
  };

  return {
    async initCursor(deviceId) {
      const names = await partitions.current();
      for (const partition of names) {
        try {
          const table = partitions.quote(partition);
          const latest = (await query(latestSql(table), [deviceId], partition))[0]?.ultima;
          const dtTrama = latest === null || latest === undefined ? null : String(latest);
          const ids = dtTrama === null ? [] : (await query(overlapIdsSql(table), [deviceId, dtTrama, opts.chainOverlapMs], partition)).map((row) => Number(row.int_id));
          return { partition, dtTrama, recentIds: ids };
        } catch (error) {
          if (!isUnreadable(error)) throw error;
        }
      }
      throw new Error(`No hay particiones legibles para el dispositivo ${deviceId}.`);
    },
    async readNew(deviceId, cursor) {
      const names = await partitions.current();
      const rows = await read(deviceId, cursor.partition, cursor.dtTrama);
      if (rows.length > 0) return process(deviceId, cursor, rows);
      const newer = names.find((name) => name > cursor.partition);
      if (!newer) return { frames: [], cursor, hasMore: false };
      try {
        const nextRows = await read(deviceId, newer, null);
        if (nextRows.length === 0) return { frames: [], cursor, hasMore: false };
        return process(deviceId, { partition: newer, dtTrama: null, recentIds: [] }, nextRows);
      } catch (error) {
        if (!isUnreadable(error)) throw error;
        return { frames: [], cursor, hasMore: false };
      }
    },
  };
}
