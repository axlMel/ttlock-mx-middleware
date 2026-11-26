import { readSecret } from './secrets';

export interface AppConfig {
  enabledCompanies: Map<number, number>;
  assignmentTz: string;
  pollIntervalMsRoutes: number;
  chainPollIntervalMs: number;
  chainMaxQueriesPerSecond: number;
  ackRetryBackoffMs: number;
  ackMaxRetries: number;
  ackResendEnabled: boolean;
  catalogRevalidateMs: number;
  chainBatchLimit: number;
  chainOverlapMs: number;
  commandApiUrl: string;
  apiKey: string;
  commandApiTimeoutMs: number;
  dryRun: boolean;
  auditLogDir: string;
  redisUrl: string;
  databaseUrl: string;
  credentialsDirectory: string | null;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuración inválida:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined>, readFile: (path: string) => string): AppConfig {
  const issues: string[] = [];
  const number = (name: string, fallback: number, minimum: number): number => {
    const raw = env[name] ?? String(fallback);
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < minimum) {
      issues.push(`${name}: debe ser un entero ${minimum === 0 ? 'no negativo' : 'positivo'}.`);
      return fallback;
    }
    return Number(raw);
  };
  const boolean = (name: string, fallback: boolean): boolean => {
    const raw = env[name] ?? String(fallback);
    if (raw !== 'true' && raw !== 'false') {
      issues.push(`${name}: debe ser true o false.`);
      return fallback;
    }
    return raw === 'true';
  };
  const positiveRate = (name: string, fallback: number): number => {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    if (!raw.trim() || !Number.isFinite(value) || value <= 0) {
      issues.push(`${name}: debe ser un número positivo y finito.`);
      return fallback;
    }
    return value;
  };
  const url = (name: string, protocols: string[]): string => {
    const raw = env[name]?.trim() ?? '';
    try {
      const parsed = new URL(raw);
      if (protocols.includes(parsed.protocol) && parsed.hostname) return raw;
    } catch { /* El error se agrega abajo, sin incluir el valor. */ }
    issues.push(`${name}: falta una URL válida con protocolo ${protocols.join(' o ')}.`);
    return '';
  };
  const enabledCompanies = new Map<number, number>();
  const pairs = env.ENABLED_COMPANIES?.trim() ?? '';
  if (!pairs) issues.push('ENABLED_COMPANIES: se requiere al menos un par plataforma:api.');
  else for (const pair of pairs.split(',')) {
    const match = /^([0-9]+):([0-9]+)$/.exec(pair.trim());
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1 ||
      !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) {
      issues.push('ENABLED_COMPANIES: cada par debe tener enteros positivos plataforma:api.');
      continue;
    }
    const platform = Number(match[1]);
    if (enabledCompanies.has(platform)) issues.push('ENABLED_COMPANIES: hay una plataforma repetida.');
    else enabledCompanies.set(platform, Number(match[2]));
  }
  const assignmentTz = env.ASSIGNMENT_TZ ?? 'UTC';
  try { new Intl.DateTimeFormat('es-MX', { timeZone: assignmentTz }); }
  catch { issues.push('ASSIGNMENT_TZ: debe ser una zona horaria IANA válida.'); }
  const credentialsDirectory = env.CREDENTIALS_DIRECTORY?.trim() || null;
  const api = readSecret(env, readFile, credentialsDirectory ?? undefined, 'command-api-key', 'COMMAND_API_KEY');
  const db = readSecret(env, readFile, credentialsDirectory ?? undefined, 'database-url', 'DATABASE_URL');
  const redis = readSecret(env, readFile, credentialsDirectory ?? undefined, 'redis-url', 'REDIS_URL');
  if (api.issue) issues.push(api.issue);
  if (db.issue) issues.push(db.issue);
  if (redis.issue) issues.push(redis.issue);
  if (db.value) {
    try {
      const parsed = new URL(db.value);
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
    } catch { issues.push('DATABASE_URL: debe ser una URL postgres:// o postgresql:// válida.'); }
  }
  if (redis.value) {
    try {
      const parsed = new URL(redis.value);
      if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
    } catch { issues.push('REDIS_URL: debe ser una URL redis:// o rediss:// válida.'); }
  }
  const auditLogDir = env.AUDIT_LOG_DIR ?? './audit';
  if (!auditLogDir.trim()) issues.push('AUDIT_LOG_DIR: la ruta no puede estar vacía.');
  const config: AppConfig = {
    enabledCompanies, assignmentTz,
    pollIntervalMsRoutes: number('POLL_INTERVAL_MS_ROUTES', 10000, 1),
    chainPollIntervalMs: number('CHAIN_POLL_INTERVAL_MS', 60000, 1),
    chainMaxQueriesPerSecond: positiveRate('CHAIN_MAX_QUERIES_PER_SECOND', 3),
    ackRetryBackoffMs: number('ACK_RETRY_BACKOFF_MS', 30000, 1),
    ackMaxRetries: number('ACK_MAX_RETRIES', 3, 1),
    ackResendEnabled: boolean('ACK_RESEND_ENABLED', true),
    catalogRevalidateMs: number('CATALOG_REVALIDATE_MS', 300000, 1),
    chainBatchLimit: number('CHAIN_BATCH_LIMIT', 500, 1),
    chainOverlapMs: number('CHAIN_OVERLAP_MS', 10000, 0),
    commandApiUrl: url('COMMAND_API_URL', ['https:']), apiKey: api.value ?? '',
    commandApiTimeoutMs: number('COMMAND_API_TIMEOUT_MS', 10000, 1),
    dryRun: boolean('COMMAND_DRY_RUN', false), auditLogDir,
    redisUrl: redis.value ?? '', databaseUrl: db.value ?? '', credentialsDirectory,
  };
  if (issues.length) throw new ConfigError(issues);
  return config;
}
