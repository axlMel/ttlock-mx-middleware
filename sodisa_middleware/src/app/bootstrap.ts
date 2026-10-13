import Redis from 'ioredis';
import { Pool } from 'pg';
import { PgDeviceDirectory } from '../device-directory/deviceDirectory';
import type { DeviceDirectory } from '../device-directory/types';
import { PgChainReportDetector } from '../event-detectors/chainReportDetector';
import { PgRouteDetector } from '../event-detectors/routeDetector';
import { startBullWorker } from '../orchestrator/worker';
import type { OrchestratorLogger } from '../orchestrator/types';
import { RedisPollingCursorStore } from '../persistence/cursorStore';
import { RedisRouteStateStore } from '../persistence/routeStateStore';
import type { AppConfig } from './config';

type WorkerHandle = Awaited<ReturnType<typeof startBullWorker>>;
type ClosableDeviceDirectory = DeviceDirectory & { close(): Promise<void> };

export interface AppHandle {
  close(): Promise<void>;
}

export interface AppFactories {
  createPool(databaseUrl: string): Pool;
  createRedis(redisUrl: string): Redis;
  createDirectory(databaseUrl: string): ClosableDeviceDirectory;
  startWorker: typeof startBullWorker;
}

const realFactories: AppFactories = {
  createPool: (databaseUrl) => new Pool({ connectionString: databaseUrl }),
  createRedis: (redisUrl) => new Redis(redisUrl),
  createDirectory: (databaseUrl) => new PgDeviceDirectory(databaseUrl),
  startWorker: startBullWorker,
};

export async function startApp(
  config: AppConfig,
  factories: AppFactories = realFactories,
  logger: OrchestratorLogger = console,
): Promise<AppHandle> {
  let pool: Pool | undefined;
  let redis: Redis | undefined;
  let directory: ClosableDeviceDirectory | undefined;
  let worker: WorkerHandle | undefined;
  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closing ??= (async () => {
      const failures: unknown[] = [];
      const closeResource = async (resource: string, action: () => Promise<unknown>): Promise<void> => {
        try {
          await action();
        } catch (error) {
          failures.push(error);
          logger.error('Falló el cierre de un recurso.', {
            timestamp: new Date().toISOString(), resource,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      };
      if (worker) await closeResource('worker', () => worker!.close());
      if (directory) await closeResource('device-directory', () => directory!.close());
      if (pool) await closeResource('postgres', () => pool!.end());
      if (redis) {
        await closeResource('redis', async () => {
          if (redis!.status === 'ready') await redis!.quit();
          else redis!.disconnect();
        });
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'No se pudieron cerrar todos los recursos del middleware.');
      }
    })();
    return closing;
  };

  try {
    pool = factories.createPool(config.databaseUrl);
    redis = factories.createRedis(config.redisUrl);
    directory = factories.createDirectory(config.databaseUrl);

    await pool.query('SELECT 1');
    await redis.ping();

    const cursorStore = new RedisPollingCursorStore(redis);
    worker = await factories.startWorker({
      routeDetector: new PgRouteDetector(pool),
      chainReportDetector: new PgChainReportDetector(pool, cursorStore),
      deviceDirectory: directory,
      stateStore: new RedisRouteStateStore(redis),
      cursorStore,
      redisUrl: config.redisUrl,
      config: config.orchestrator,
      logger,
    });
    return { close };
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Falló el arranque y la limpieza del middleware.');
    }
    throw error;
  }
}
