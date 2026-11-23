import type { SqlClient } from '../catalog';
import { createChainReader } from '../detectors';
import { createChainQueryLimiter } from '../orchestrator';
import { rateLimitedChainSql } from './chainSql';

afterEach(() => { jest.useRealTimers(); });

test('limita por separado las dos consultas de initCursor y las dos de readNew al cambiar partición', async () => {
  jest.useFakeTimers({ now: 0 });
  const times: number[] = [];
  const db: SqlClient = { query: async (sql) => {
    if (sql.includes('FROM pg_namespace')) return { rows: [{ oid: 1 }] };
    if (sql.includes('FROM pg_class')) return { rows: [{ relname: '202647' }, { relname: '202646' }] };
    times.push(Date.now());
    if (sql.includes('max(dt_trama)')) return { rows: [{ ultima: '2026-11-17 12:00:00' }] };
    return { rows: [] };
  } };
  const limiter = createChainQueryLimiter(3);
  const reader = createChainReader(rateLimitedChainSql(db, limiter), { assignmentTz: 'UTC', chainBatchLimit: 500,
    chainOverlapMs: 10000, partitionRefreshMs: 600000, now: Date.now });
  const init = reader.initCursor(9001);
  await jest.advanceTimersByTimeAsync(334);
  await init;
  const read = reader.readNew(9001, { partition: '202646', dtTrama: null, recentIds: [] });
  await jest.advanceTimersByTimeAsync(668);
  await read;
  expect(times).toEqual([0, 334, 668, 1002]);
  await limiter.close();
});
