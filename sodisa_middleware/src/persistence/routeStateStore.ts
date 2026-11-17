import type Redis from 'ioredis';
import { deviceRouteKey, isRouteKey, routeKey, routeScanPattern } from './keys';
import { CorruptStateError, type RouteState } from './types';

export interface RouteStateStore {
  get(assignmentId: number): Promise<RouteState | null>;
  getByDevice(deviceId: number): Promise<RouteState | null>;
  set(state: RouteState): Promise<void>;
  delete(assignmentId: number): Promise<void>;
  list(): Promise<RouteState[]>;
}

export interface RouteStateStoreOptions {
  onCorrupt?: (key: string, error: CorruptStateError) => void;
}

export class RedisRouteStateStore implements RouteStateStore {
  constructor(private readonly redis: Redis, private readonly options: RouteStateStoreOptions = {}) {}

  async get(assignmentId: number): Promise<RouteState | null> {
    const key = routeKey(assignmentId);
    const value = await this.redis.get(key);
    return value === null ? null : this.parse(key, value);
  }

  async getByDevice(deviceId: number): Promise<RouteState | null> {
    const key = deviceRouteKey(deviceId);
    const assignmentId = await this.redis.get(key);
    if (assignmentId === null) return null;
    if (!/^[0-9]+$/.test(assignmentId)) throw new CorruptStateError(key);
    return this.get(Number(assignmentId));
  }

  async set(state: RouteState): Promise<void> {
    const previous = await this.get(state.assignmentId);
    const transaction = this.redis.multi();
    if (previous !== null && previous.deviceId !== state.deviceId) {
      transaction.del(deviceRouteKey(previous.deviceId));
    }
    transaction.set(routeKey(state.assignmentId), JSON.stringify(state));
    transaction.set(deviceRouteKey(state.deviceId), String(state.assignmentId));
    await transaction.exec();
  }

  async delete(assignmentId: number): Promise<void> {
    const state = await this.get(assignmentId);
    const transaction = this.redis.multi().del(routeKey(assignmentId));
    if (state !== null) transaction.del(deviceRouteKey(state.deviceId));
    await transaction.exec();
  }

  async list(): Promise<RouteState[]> {
    const states = new Map<string, RouteState>();
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', routeScanPattern, 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        if (!isRouteKey(key)) continue;
        const value = await this.redis.get(key);
        if (value === null) continue;
        try { states.set(key, this.parse(key, value)); }
        catch (error) {
          if (!(error instanceof CorruptStateError)) throw error;
          this.options.onCorrupt?.(key, error);
        }
      }
    } while (cursor !== '0');
    return [...states.values()];
  }

  private parse(key: string, value: string): RouteState {
    try {
      const parsed = JSON.parse(value) as RouteState;
      return { ...parsed, lastAcceptedCommand: parsed.lastAcceptedCommand ?? null };
    }
    catch (error) { throw new CorruptStateError(key, { cause: error }); }
  }
}
