import type Redis from 'ioredis';
import { catalogKey } from './keys';
import { CorruptStateError, type CatalogEntry } from './types';

export interface CatalogCacheStore {
  get<T>(entity: string, id: number): Promise<CatalogEntry<T> | null>;
  set<T>(entity: string, id: number, entry: CatalogEntry<T>): Promise<void>;
  delete(entity: string, id: number): Promise<void>;
}

export class RedisCatalogCacheStore implements CatalogCacheStore {
  constructor(private readonly redis: Redis) {}

  async get<T>(entity: string, id: number): Promise<CatalogEntry<T> | null> {
    const key = catalogKey(entity, id);
    const value = await this.redis.get(key);
    if (value === null) return null;
    try { return JSON.parse(value) as CatalogEntry<T>; }
    catch (error) { throw new CorruptStateError(key, { cause: error }); }
  }

  async set<T>(entity: string, id: number, entry: CatalogEntry<T>): Promise<void> {
    await this.redis.set(catalogKey(entity, id), JSON.stringify(entry));
  }

  async delete(entity: string, id: number): Promise<void> {
    await this.redis.del(catalogKey(entity, id));
  }
}
