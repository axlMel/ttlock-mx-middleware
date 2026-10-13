import type Redis from 'ioredis';
import type { Pool } from 'pg';
import type { DeviceDirectoryEntry } from '../device-directory/types';
import { PgChainReportDetector } from '../event-detectors/chainReportDetector';
import { PgRouteDetector } from '../event-detectors/routeDetector';
import type { startBullWorker } from '../orchestrator/worker';
import type { OrchestratorLogger } from '../orchestrator/types';
import { RedisPollingCursorStore } from '../persistence/cursorStore';
import { RedisRouteStateStore } from '../persistence/routeStateStore';
import { startApp, type AppFactories } from './bootstrap';
import type { AppConfig } from './config';

const config: AppConfig = {
  databaseUrl: 'postgres://user:secret@127.0.0.1:5433/local',
  redisUrl: 'redis://127.0.0.1:6379',
  orchestrator: {
    pollIntervalRoutesMs: 2000, pollIntervalAckMs: 1000,
    ackMaxRetries: 2, ackRetryBackoffMs: 15000,
  },
};

function fixtures() {
  const calls: string[] = [];
  const pool = {
    query: jest.fn(async (sql: string) => { calls.push(`pg:${sql}`); return { rows: [] }; }),
    end: jest.fn(async () => { calls.push('pg:close'); }),
  } as unknown as Pool;
  const redis = {
    status: 'ready',
    ping: jest.fn(async () => { calls.push('redis:ping'); return 'PONG'; }),
    quit: jest.fn(async () => { calls.push('redis:close'); return 'OK'; }),
    disconnect: jest.fn(() => { calls.push('redis:disconnect'); }),
  } as unknown as Redis;
  const directory = {
    getDeviceInfo: jest.fn(async (imei: string): Promise<DeviceDirectoryEntry> => ({
      imei, model: 'GV300W', ip: '127.0.0.1', port: 55010,
    })),
    close: jest.fn(async () => { calls.push('directory:close'); }),
  };
  const worker = {
    close: jest.fn(async () => { calls.push('worker:close'); }),
  };
  const startWorker = jest.fn(async (dependencies: Parameters<typeof startBullWorker>[0]) => {
    void dependencies;
    return worker;
  });
  const factories: AppFactories = {
    createPool: jest.fn(() => pool),
    createRedis: jest.fn(() => redis),
    createDirectory: jest.fn(() => directory),
    startWorker: startWorker as unknown as AppFactories['startWorker'],
  };
  const logger: jest.Mocked<OrchestratorLogger> = {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  };
  return { calls, pool, redis, directory, worker, startWorker, factories, logger };
}

test('conecta implementaciones reales y arranca 002 una sola vez después de comprobar pg y Redis', async () => {
  const f = fixtures();
  const app = await startApp(config, f.factories, f.logger);
  expect(f.factories.createPool).toHaveBeenCalledWith(config.databaseUrl);
  expect(f.factories.createRedis).toHaveBeenCalledWith(config.redisUrl);
  expect(f.factories.createDirectory).toHaveBeenCalledWith(config.databaseUrl);
  expect(f.calls).toEqual(['pg:SELECT 1', 'redis:ping']);
  expect(f.startWorker).toHaveBeenCalledTimes(1);
  const dependencies = f.startWorker.mock.calls[0]![0];
  expect(dependencies.routeDetector).toBeInstanceOf(PgRouteDetector);
  expect(dependencies.chainReportDetector).toBeInstanceOf(PgChainReportDetector);
  expect(dependencies.stateStore).toBeInstanceOf(RedisRouteStateStore);
  expect(dependencies.cursorStore).toBeInstanceOf(RedisPollingCursorStore);
  expect(dependencies.deviceDirectory).toBe(f.directory);
  expect(dependencies).toMatchObject({ redisUrl: config.redisUrl, config: config.orchestrator, logger: f.logger });
  expect(dependencies).not.toHaveProperty('protocol');
  await app.close();
  expect(f.calls.slice(2)).toEqual(['worker:close', 'directory:close', 'pg:close', 'redis:close']);
});

test('cierra una sola vez y continúa tras un fallo de cierre', async () => {
  const f = fixtures();
  f.worker.close.mockImplementationOnce(async () => {
    f.calls.push('worker:close');
    throw new Error('fallo simulado');
  });
  const app = await startApp(config, f.factories, f.logger);
  const first = app.close();
  const second = app.close();
  expect(first).toBe(second);
  await expect(first).rejects.toThrow('No se pudieron cerrar todos los recursos');
  expect(f.calls.slice(2)).toEqual(['worker:close', 'directory:close', 'pg:close', 'redis:close']);
  expect(f.worker.close).toHaveBeenCalledTimes(1);
  expect(f.logger.error).toHaveBeenCalledWith('Falló el cierre de un recurso.',
    expect.objectContaining({ resource: 'worker', timestamp: expect.any(String) }));
});

test.each(['postgres', 'redis', 'worker'] as const)(
  'libera todos los recursos creados si falla %s durante el arranque', async (stage) => {
    const f = fixtures();
    if (stage === 'postgres') {
      (f.pool.query as unknown as jest.Mock).mockRejectedValueOnce(new Error('sin Postgres'));
    }
    if (stage === 'redis') jest.spyOn(f.redis, 'ping').mockRejectedValueOnce(new Error('sin Redis'));
    if (stage === 'worker') f.startWorker.mockImplementationOnce(async () => { throw new Error('sin BullMQ'); });
    await expect(startApp(config, f.factories, f.logger)).rejects.toThrow();
    expect(f.directory.close).toHaveBeenCalledTimes(1);
    expect(f.pool.end).toHaveBeenCalledTimes(1);
    expect(f.redis.quit).toHaveBeenCalledTimes(1);
    expect(f.worker.close).toHaveBeenCalledTimes(0);
  },
);

test('desconecta Redis sin esperar quit si nunca llegó al estado listo', async () => {
  const f = fixtures();
  (f.redis as unknown as { status: string }).status = 'reconnecting';
  (f.redis.ping as jest.Mock).mockRejectedValueOnce(new Error('sin Redis'));
  await expect(startApp(config, f.factories, f.logger)).rejects.toThrow('sin Redis');
  expect(f.redis.disconnect).toHaveBeenCalledTimes(1);
  expect(f.redis.quit).not.toHaveBeenCalled();
  expect(f.pool.end).toHaveBeenCalledTimes(1);
});
