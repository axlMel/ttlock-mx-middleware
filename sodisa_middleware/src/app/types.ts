import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { Scheduler } from '../orchestrator';
import type { AppConfig } from '../config';

export type PgPool = Pick<Pool, 'query' | 'end'>;
export type RedisLike = Redis;

export interface AppFactories {
  createPool(config: AppConfig): PgPool;
  createRedis(config: AppConfig, role: 'state' | 'queue'): RedisLike;
  createScheduler(config: AppConfig, redis: RedisLike): Scheduler;
  now(): number;
}

export interface App {
  start(): Promise<void>;
  shutdown(reason: string): Promise<void>;
}
