import { ConfigError, loadConfig, redactConfig } from './index';
import { join } from 'node:path';

const valid = { ENABLED_COMPANIES: '364:2', COMMAND_API_URL: 'https://api.example.test/send',
  REDIS_URL: 'redis://localhost:6379', COMMAND_API_KEY: 'CLAVE_SUPER_SECRETA',
  DATABASE_URL: 'postgres://user:CONTRASENA_SUPER_SECRETA@db.example.test/db' };
const missingFile = (): never => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };

test('convierte defaults, pares y booleanos', () => {
  const config = loadConfig(valid, missingFile);
  expect(config.enabledCompanies).toEqual(new Map([[364, 2]]));
  expect(config).toMatchObject({ assignmentTz: 'UTC', startMarginMinutes: 15, pollIntervalMsRoutes: 10000,
    pollIntervalMsAck: 3000, ackRetryBackoffMs: 60000, ackMaxRetries: 3,
    ackResendEnabled: true, catalogRevalidateMs: 300000, chainBatchLimit: 500,
    chainOverlapMs: 10000, partitionRefreshMs: 600000, commandApiTimeoutMs: 10000,
    dryRun: false, auditLogDir: './audit' });
  expect(loadConfig({ ...valid, COMMAND_DRY_RUN: 'true', ACK_RESEND_ENABLED: 'false', CHAIN_OVERLAP_MS: '0' }, missingFile))
    .toMatchObject({ dryRun: true, ackResendEnabled: false, chainOverlapMs: 0 });
});

test.each(['START_MARGIN_MINUTES', 'POLL_INTERVAL_MS_ROUTES', 'POLL_INTERVAL_MS_ACK',
  'ACK_RETRY_BACKOFF_MS', 'ACK_MAX_RETRIES', 'CATALOG_REVALIDATE_MS', 'CHAIN_BATCH_LIMIT',
  'PARTITION_REFRESH_MS', 'COMMAND_API_TIMEOUT_MS'])('%s exige entero positivo', (name) => {
  expect(() => loadConfig({ ...valid, [name]: '0' }, missingFile)).toThrow(name);
  expect(() => loadConfig({ ...valid, [name]: '1.5' }, missingFile)).toThrow(name);
});

test('valida todos los errores a la vez y no imprime valores secretos', () => {
  const env = { ...valid, ENABLED_COMPANIES: '364:2,364:3,wrong', ASSIGNMENT_TZ: 'Not/AZone',
    COMMAND_API_URL: 'http://bad.test', REDIS_URL: 'http://bad.test',
    COMMAND_DRY_RUN: 'TRUE', CHAIN_OVERLAP_MS: '-1', AUDIT_LOG_DIR: '', DATABASE_URL: 'invalid-secret' };
  try { loadConfig(env, missingFile); throw new Error('debió fallar'); }
  catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const message = String(error);
    for (const name of ['ENABLED_COMPANIES', 'ASSIGNMENT_TZ', 'COMMAND_API_URL', 'REDIS_URL',
      'COMMAND_DRY_RUN', 'CHAIN_OVERLAP_MS', 'AUDIT_LOG_DIR', 'DATABASE_URL']) expect(message).toContain(name);
    expect(message).not.toContain('invalid-secret');
    expect(message).not.toContain(valid.COMMAND_API_KEY);
  }
});

test('rechaza pares mal formados, duplicados y booleanos no exactos', () => {
  for (const pair of ['364', '0:2', '364:0', '364:2,', '364:2,364:1', '999999999999999999999:1'])
    expect(() => loadConfig({ ...valid, ENABLED_COMPANIES: pair }, missingFile)).toThrow('ENABLED_COMPANIES');
  for (const value of ['TRUE', '1', 'yes', ''])
    expect(() => loadConfig({ ...valid, ACK_RESEND_ENABLED: value }, missingFile)).toThrow('ACK_RESEND_ENABLED');
});

test('credenciales de systemd tienen prioridad, se recortan y no se revelan', () => {
  const files = new Map([[join('/run/creds', 'command-api-key'), '  FILE_API_KEY\n'],
    [join('/run/creds', 'database-url'), ' postgres://u:FILE_PASSWORD@host/db\n']]);
  const config = loadConfig({ ...valid, CREDENTIALS_DIRECTORY: '/run/creds' }, (path) => files.get(path) ?? missingFile());
  expect(config.apiKey).toBe('FILE_API_KEY');
  expect(config.databaseUrl).toContain('FILE_PASSWORD');
  const redacted = JSON.stringify(redactConfig(config));
  expect(redacted).not.toContain('FILE_API_KEY');
  expect(redacted).not.toContain('FILE_PASSWORD');
  expect(redacted).not.toContain(valid.COMMAND_API_KEY);
  expect(redacted).not.toContain('CONTRASENA_SUPER_SECRETA');
});

test('archivo inexistente usa entorno; archivo ilegible o vacío no revela contenido', () => {
  expect(loadConfig({ ...valid, CREDENTIALS_DIRECTORY: '/run/creds' }, missingFile).apiKey).toBe(valid.COMMAND_API_KEY);
  for (const readFile of [() => '   ', () => { throw new Error('CLAVE_INTERNA'); }]) {
    try { loadConfig({ ...valid, CREDENTIALS_DIRECTORY: '/run/creds' }, readFile); throw new Error('debió fallar'); }
    catch (error) { expect(String(error)).not.toContain('CLAVE_INTERNA'); }
  }
  expect(() => loadConfig({ ...valid, COMMAND_API_KEY: '', DATABASE_URL: '' }, missingFile)).toThrow(ConfigError);
});
