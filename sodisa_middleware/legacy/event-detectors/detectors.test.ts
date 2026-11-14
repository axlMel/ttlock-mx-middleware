import Redis from 'ioredis';
import { Pool } from 'pg';
import { RedisPollingCursorStore } from '../persistence/cursorStore';
import { PgChainReportDetector } from './chainReportDetector';
import { PgRouteDetector } from './routeDetector';

// La suite consulta la PostgreSQL local y aísla su cursor en Redis DB 15.
const LOCAL_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://gtlock_dev:gtlock_dev@127.0.0.1:5433/atagps_local';
const CURSOR_KEY = 'cursor:reporte_cadenas';

describe('detectores contra la BD local', () => {
  let pool: Pool;
  let redis: Redis;
  let originalCursor: string | null;
  let routeDetector: PgRouteDetector;
  let chainReportDetector: PgChainReportDetector;
  let cursorStore: RedisPollingCursorStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: LOCAL_DATABASE_URL });
    redis = new Redis({ host: '127.0.0.1', port: 6379, db: 15 });
    originalCursor = await redis.get(CURSOR_KEY);
    await redis.del(CURSOR_KEY);
    cursorStore = new RedisPollingCursorStore(redis);
    routeDetector = new PgRouteDetector(pool);
    chainReportDetector = new PgChainReportDetector(pool, cursorStore);
  });

  afterAll(async () => {
    if (originalCursor === null) {
      await redis.del(CURSOR_KEY);
    } else {
      await redis.set(CURSOR_KEY, originalCursor);
    }
    redis.disconnect();
    await pool.end();
  });

  test('devuelve las asignaciones vigentes sembradas con coordenadas numéricas', async () => {
    const routes = await routeDetector.getActiveRoutes();

    expect(routes).toEqual(
      expect.arrayContaining([
        {
          imei: '863457050476769',
          latitude: 19.355383,
          longitude: -99.128206,
          radius: 50,
          order: 1,
        },
        {
          imei: '863457050476769',
          latitude: 19.36,
          longitude: -99.13,
          radius: 60,
          order: 2,
        },
      ]),
    );
  });

  test('lee reportes desde el cursor, lo avanza y no repite el lote', async () => {
    await redis.del(CURSOR_KEY);
    const firstBatch = await chainReportDetector.getNewEvents();

    expect(firstBatch.length).toBeGreaterThanOrEqual(6);
    expect(firstBatch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          imei: '863457050476769',
          raw: '+ACK:GTGEO,270D04,863457050476769,,0,FFFF,20260921220939,03C8',
        }),
        expect.objectContaining({
          imei: '868589060960328',
          raw: '+ACK:GTGEO,6E0A03,868589060960328,,0,FFFF,20260925001304,01CA',
        }),
      ]),
    );
    expect(await cursorStore.get('reporte_cadenas')).toBe(firstBatch.at(-1)?.idReport);
    await expect(chainReportDetector.getNewEvents()).resolves.toEqual([]);
  });

  test('respeta un cursor ya guardado', async () => {
    const firstRow = await pool.query<{ id_report: string }>(
      'SELECT id_report FROM reporte_cadenas ORDER BY id_report LIMIT 1',
    );
    const firstId = String(firstRow.rows[0].id_report);
    await cursorStore.set('reporte_cadenas', firstId);

    const events = await chainReportDetector.getNewEvents();

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => BigInt(event.idReport) > BigInt(firstId))).toBe(true);
    expect(await cursorStore.get('reporte_cadenas')).toBe(events.at(-1)?.idReport);
  });
});
