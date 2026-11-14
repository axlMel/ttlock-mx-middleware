import { configFromEnv } from '../orchestrator/worker';
import type { OrchestratorConfig } from '../orchestrator/types';

export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
  orchestrator: OrchestratorConfig;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function readAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const required = (name: 'DATABASE_URL' | 'REDIS_URL'): string => {
    const value = env[name]?.trim();
    if (!value) throw new ConfigurationError(`Falta configurar ${name}.`);
    return value;
  };

  const databaseUrl = required('DATABASE_URL');
  const redisUrl = required('REDIS_URL');
  try {
    return { databaseUrl, redisUrl, orchestrator: configFromEnv(env) };
  } catch (error) {
    if (error instanceof Error) throw new ConfigurationError(error.message);
    throw new ConfigurationError('La configuración de polling y reintentos no es válida.');
  }
}
