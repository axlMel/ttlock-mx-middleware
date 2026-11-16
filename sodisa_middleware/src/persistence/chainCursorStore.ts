import type Redis from 'ioredis';
import { chainCursorKey } from './keys';
import { CorruptStateError, type ChainCursor } from './types';

export interface ChainCursorStore {
  get(deviceId: number): Promise<ChainCursor | null>;
  set(deviceId: number, cursor: ChainCursor): Promise<void>;
  delete(deviceId: number): Promise<void>;
}

export class RedisChainCursorStore implements ChainCursorStore {
  constructor(private readonly redis: Redis) {}

  async get(deviceId: number): Promise<ChainCursor | null> {
    const key = chainCursorKey(deviceId);
    const value = await this.redis.get(key);
    if (value === null) return null;
    try { return JSON.parse(value) as ChainCursor; }
    catch (error) { throw new CorruptStateError(key, { cause: error }); }
  }

  async set(deviceId: number, cursor: ChainCursor): Promise<void> {
    await this.redis.set(chainCursorKey(deviceId), JSON.stringify(cursor));
  }

  async delete(deviceId: number): Promise<void> {
    await this.redis.del(chainCursorKey(deviceId));
  }
}
