import { createChainQueryLimiter } from './chainQueryLimiter';

afterEach(() => { jest.useRealTimers(); });

test('limita cada consulta SQL de 30 inicializaciones simultáneas, incluidas sus segundas consultas', async () => {
  jest.useFakeTimers({ now: 0 });
  const limiter = createChainQueryLimiter(3);
  const starts: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const query = () => limiter.run(async () => {
    starts.push(Date.now());
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return { rows: [1] };
  });
  const jobs = Array.from({ length: 30 }, async () => { await query(); await query(); });
  await jest.advanceTimersByTimeAsync(20_000);
  await Promise.all(jobs);
  expect(starts).toHaveLength(60);
  expect(maxInFlight).toBe(1);
  for (let i = 1; i < starts.length; i += 1) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(1000 / 3);
  for (const start of starts) expect(starts.filter((at) => at >= start && at < start + 1000).length).toBeLessThanOrEqual(3);
  expect(limiter.takeStats()).toMatchObject({ queries: 60, rows: 60 });
  await limiter.close();
});

test('una tasa de 0.5 permite una consulta cada dos segundos', async () => {
  jest.useFakeTimers({ now: 0 });
  const limiter = createChainQueryLimiter(0.5);
  const starts: number[] = [];
  const jobs = Array.from({ length: 3 }, () => limiter.run(async () => { starts.push(Date.now()); return { rows: [] }; }));
  await jest.advanceTimersByTimeAsync(4000);
  await Promise.all(jobs);
  expect(starts).toEqual([0, 2000, 4000]);
  await limiter.close();
});

test('una tasa de 3.5 mantiene como máximo tres consultas por ventana móvil de un segundo', async () => {
  jest.useFakeTimers({ now: 0 });
  const limiter = createChainQueryLimiter(3.5);
  const starts: number[] = [];
  const jobs = Array.from({ length: 8 }, () => limiter.run(async () => { starts.push(Date.now()); return { rows: [] }; }));
  await jest.advanceTimersByTimeAsync(3000);
  await Promise.all(jobs);
  for (const start of starts) expect(starts.filter((at) => at >= start && at < start + 1000).length)
    .toBeLessThanOrEqual(3);
  await limiter.close();
});

test('fallos SQL consecutivos duplican el espaciado hasta 10 s y un éxito lo restaura', async () => {
  jest.useFakeTimers({ now: 0 });
  const limiter = createChainQueryLimiter(3);
  const starts: number[] = [];
  let failures = 5;
  const jobs = Array.from({ length: 8 }, () => limiter.run(async () => {
    starts.push(Date.now());
    if (failures-- > 0) throw new Error('fallo');
    return { rows: [] };
  }).catch(() => undefined));
  await jest.advanceTimersByTimeAsync(50_000);
  await Promise.all(jobs);
  const gaps = starts.slice(1).map((at, i) => at - starts[i]);
  expect(gaps.slice(0, 5)).toEqual([667, 1334, 2667, 5334, 10000]);
  expect(gaps[5]).toBe(334);
  await limiter.close();
});
