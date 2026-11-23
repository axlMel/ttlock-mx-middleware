export interface ChainQueryStats {
  queries: number;
  rows: number;
  avgDurationMs: number;
  maxDurationMs: number;
  throttledMs: number;
}

export interface ChainQueryLimiter {
  run<T extends { rows: unknown[] }>(query: () => Promise<T>): Promise<T>;
  takeStats(): ChainQueryStats;
  minimumSpacingMs(): number;
  close(): Promise<void>;
}

interface WaitingQuery {
  execute(): Promise<void>;
  reject(error: Error): void;
}

export function createChainQueryLimiter(maxQueriesPerSecond: number, now: () => number = Date.now): ChainQueryLimiter {
  if (!Number.isFinite(maxQueriesPerSecond) || maxQueriesPerSecond <= 0)
    throw new Error('El tope de consultas de tramas debe ser positivo y finito.');
  const baseSpacingMs = 1000 / maxQueriesPerSecond;
  const maxInSecond = maxQueriesPerSecond >= 1 ? Math.floor(maxQueriesPerSecond) : null;
  const queue: WaitingQuery[] = [];
  const starts: number[] = [];
  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  let closed = false;
  let lastStart: number | null = null;
  let failures = 0;
  let active: Promise<void> | null = null;
  let stats = { queries: 0, rows: 0, totalDurationMs: 0, maxDurationMs: 0, throttledMs: 0 };

  const spacing = (): number => Math.max(baseSpacingMs, Math.min(10_000, baseSpacingMs * 2 ** Math.min(failures, 40)));
  const pump = (): void => {
    if (busy || closed || queue.length === 0) return;
    const current = now();
    while (starts.length && starts[0] <= current - 1000) starts.shift();
    const gapAt = lastStart === null ? current : lastStart + spacing();
    const windowAt = maxInSecond !== null && starts.length >= maxInSecond ? starts[0] + 1000 : current;
    const waitMs = Math.max(0, gapAt - current, windowAt - current);
    if (waitMs > 0) {
      timer = setTimeout(() => { timer = null; pump(); }, Math.min(Math.ceil(waitMs), 2_147_483_647));
      return;
    }
    const item = queue.shift()!;
    busy = true;
    lastStart = now();
    starts.push(lastStart);
    active = item.execute().finally(() => {
      busy = false;
      active = null;
      pump();
    });
  };

  return {
    run<T extends { rows: unknown[] }>(query: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error('El limitador de tramas está cerrado.'));
      const queuedAt = now();
      return new Promise<T>((resolve, reject) => {
        queue.push({ reject, execute: async () => {
          const startedAt = now();
          stats.throttledMs += Math.max(0, startedAt - queuedAt);
          try {
            const result = await query();
            failures = 0;
            stats.rows += result.rows.length;
            resolve(result);
          } catch (error) {
            failures += 1;
            reject(error);
          } finally {
            const duration = Math.max(0, now() - startedAt);
            stats.queries += 1;
            stats.totalDurationMs += duration;
            stats.maxDurationMs = Math.max(stats.maxDurationMs, duration);
          }
        } });
        pump();
      });
    },
    takeStats(): ChainQueryStats {
      const snapshot = { queries: stats.queries, rows: stats.rows,
        avgDurationMs: stats.queries ? stats.totalDurationMs / stats.queries : 0,
        maxDurationMs: stats.maxDurationMs, throttledMs: stats.throttledMs };
      stats = { queries: 0, rows: 0, totalDurationMs: 0, maxDurationMs: 0, throttledMs: 0 };
      return snapshot;
    },
    minimumSpacingMs: spacing,
    async close(): Promise<void> {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const item of queue.splice(0)) item.reject(new Error('El limitador de tramas está cerrado.'));
      if (active) await active;
    },
  };
}
