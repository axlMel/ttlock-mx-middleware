import type Redis from 'ioredis';

export interface PollingCursorStore {
  get(sourceName: string): Promise<string | null>;
  set(sourceName: string, cursorValue: string): Promise<void>;
}

export class RedisPollingCursorStore implements PollingCursorStore {
  constructor(private readonly redis: Redis) {}

  async get(sourceName: string): Promise<string | null> {
    return this.redis.get(`cursor:${sourceName}`);
  }

  async set(sourceName: string, cursorValue: string): Promise<void> {
    await this.redis.set(`cursor:${sourceName}`, cursorValue);
  }
}
