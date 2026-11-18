import { Pool } from 'pg';
import Redis from 'ioredis';
import { BullMqScheduler } from '../orchestrator';
import type { AppFactories } from './types';

export const realFactories: AppFactories = {
  createPool: (config) => new Pool({ connectionString: config.databaseUrl, max: 3,
    statement_timeout: 5000, application_name: 'gtlock-middleware' }),
  createRedis: (config, role) => new Redis(config.redisUrl,
    { lazyConnect: true, maxRetriesPerRequest: role === 'queue' ? null : 20 }),
  createScheduler: (_config, redis) => new BullMqScheduler('gtlock-steps', redis),
  now: () => Date.now(),
};
