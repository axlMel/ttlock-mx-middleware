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
    const state = await this.get(Number(assignmentId));
    return state?.fsmState === 'COMPLETED' ? null : state;
  }

  async set(state: RouteState): Promise<void> {
    const previous = await this.get(state.assignmentId);
    await this.redis.eval(`
      if KEYS[3] ~= KEYS[2] and redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('DEL', KEYS[3]) end
      redis.call('SET', KEYS[1], ARGV[2])
      if ARGV[3] == 'COMPLETED' then
        if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
      else
        local owner = redis.call('GET', KEYS[2])
        if not owner or owner == ARGV[1] then redis.call('SET', KEYS[2], ARGV[1]) end
      end
      return 1
    `, 3, routeKey(state.assignmentId), deviceRouteKey(state.deviceId),
    deviceRouteKey(previous?.deviceId ?? state.deviceId), String(state.assignmentId), JSON.stringify(state), state.fsmState);
  }

  async delete(assignmentId: number): Promise<void> {
    const state = await this.get(assignmentId);
    if (!state) return;
    await this.redis.eval(`
      redis.call('DEL', KEYS[1])
      if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
      return 1
    `, 2, routeKey(assignmentId), deviceRouteKey(state.deviceId), String(assignmentId));
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
      return { ...parsed, lastAcceptedCommand: parsed.lastAcceptedCommand ?? null,
        firstTransmissionAt: parsed.firstTransmissionAt ?? null,
        ...(parsed.closing && !parsed.closingPhase ? { closingPhase: 'RESET' as const } : {}),
        fsmState: (parsed.fsmState as string) === 'IN_ZONE' ? 'AWAITING_ENTER_ALERT' : parsed.fsmState };
    }
    catch (error) { throw new CorruptStateError(key, { cause: error }); }
  }
}
