import type Redis from 'ioredis';
import type { RouteState } from './types';

export interface RouteStateStore {
  get(deviceId: string): Promise<RouteState | null>;
  set(deviceId: string, state: RouteState): Promise<void>;
  delete(deviceId: string): Promise<void>;
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
}
