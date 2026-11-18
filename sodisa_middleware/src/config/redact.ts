import type { AppConfig } from './loadConfig';

export function redactConfig(config: AppConfig): Record<string, unknown> {
  return { ...config, enabledCompanies: [...config.enabledCompanies], apiKey: '***', databaseUrl: '***',
    redisUrl: '***', commandApiUrl: '***' };
}
