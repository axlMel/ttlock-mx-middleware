import type Redis from 'ioredis';
import type { RouteState } from './types';

export interface RouteStateStore {
  get(deviceId: string): Promise<RouteState | null>;
  set(deviceId: string, state: RouteState): Promise<void>;
  delete(deviceId: string): Promise<void>;
  list(): Promise<RouteState[]>;
}

export class RedisRouteStateStore implements RouteStateStore {
  constructor(private readonly redis: Redis) {}

  async get(deviceId: string): Promise<RouteState | null> {
    const value = await this.redis.get(`route:${deviceId}`);
    return value === null ? null : (JSON.parse(value) as RouteState);
  }

  async set(deviceId: string, state: RouteState): Promise<void> {
    await this.redis.set(`route:${deviceId}`, JSON.stringify(state));
  }

  async delete(deviceId: string): Promise<void> {
    await this.redis.del(`route:${deviceId}`);
  }

  async list(): Promise<RouteState[]> {
    const states = new Map<string, RouteState>();
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', 'route:*', 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length === 0) continue;
      const values = await this.redis.mget(...keys);
      for (let index = 0; index < keys.length; index += 1) {
        const value = values[index];
        if (value !== null) states.set(keys[index], JSON.parse(value) as RouteState);
      }
    } while (cursor !== '0');
    return [...states.values()];
  }
}
