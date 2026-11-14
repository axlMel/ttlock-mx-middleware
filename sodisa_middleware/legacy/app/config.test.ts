import { ConfigurationError, readAppConfig } from './config';

const validEnv = {
  DATABASE_URL: 'postgres://user:secret@127.0.0.1:5433/local',
  REDIS_URL: 'redis://127.0.0.1:6379',
  POLL_INTERVAL_MS_ROUTES: '2000',
  POLL_INTERVAL_MS_ACK: '1000',
  ACK_MAX_RETRIES: '0',
  ACK_RETRY_BACKOFF_MS: '15000',
};

test('lee la configuración obligatoria y reutiliza la validación numérica de 002', () => {
  expect(readAppConfig(validEnv)).toEqual({
    databaseUrl: validEnv.DATABASE_URL,
    redisUrl: validEnv.REDIS_URL,
    orchestrator: {
      pollIntervalRoutesMs: 2000,
      pollIntervalAckMs: 1000,
      ackMaxRetries: 0,
      ackRetryBackoffMs: 15000,
    },
  });
});

test.each(['DATABASE_URL', 'REDIS_URL'] as const)('rechaza %s ausente o vacía sin revelar secretos', (name) => {
  for (const value of [undefined, '   ']) {
    const error = (() => {
      try {
        readAppConfig({ ...validEnv, [name]: value });
      } catch (caught) {
        return caught;
      }
      throw new Error('Se esperaba un error de configuración.');
    })();
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain(name);
    expect((error as Error).message).not.toContain('secret');
  }
});

test('rechaza intervalos y reintentos inválidos con un error seguro', () => {
  for (const change of [
    { POLL_INTERVAL_MS_ROUTES: '0' },
    { POLL_INTERVAL_MS_ACK: '1.5' },
    { ACK_MAX_RETRIES: '-1' },
    { ACK_RETRY_BACKOFF_MS: undefined },
  ]) {
    expect(() => readAppConfig({ ...validEnv, ...change })).toThrow(ConfigurationError);
  }
});
