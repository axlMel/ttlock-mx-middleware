import { EventEmitter } from 'node:events';
import type { OrchestratorLogger } from '../orchestrator/types';
import { runMain } from './main';

class FakeProcess extends EventEmitter {
  exitCode: number | undefined;
}

const env = {
  DATABASE_URL: 'postgres://user:secret@127.0.0.1:5433/local',
  REDIS_URL: 'redis://127.0.0.1:6379',
  POLL_INTERVAL_MS_ROUTES: '2000',
  POLL_INTERVAL_MS_ACK: '1000',
  ACK_MAX_RETRIES: '2',
  ACK_RETRY_BACKOFF_MS: '15000',
};

function setup() {
  const processControl = new FakeProcess();
  const logger: jest.Mocked<OrchestratorLogger> = {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  };
  const close = jest.fn(async () => undefined);
  const bootstrap = jest.fn(async () => ({ close }));
  return { processControl, logger, close, bootstrap };
}

test.each(['SIGINT', 'SIGTERM'] as const)('%s cierra una sola vez y registra el apagado', async (signal) => {
  const f = setup();
  await runMain({ env, ...f, now: () => '2026-10-12T12:00:00.000Z' });
  expect(f.bootstrap).toHaveBeenCalledTimes(1);
  f.processControl.emit(signal);
  f.processControl.emit(signal);
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.processControl.exitCode).toBe(0);
  expect(f.logger.info).toHaveBeenCalledWith('Middleware detenido.',
    { timestamp: '2026-10-12T12:00:00.000Z' });
});

test('una señal durante el arranque espera al manejador y después cierra', async () => {
  const f = setup();
  let finishStart!: (value: { close: typeof f.close }) => void;
  f.bootstrap.mockImplementationOnce(() => new Promise((resolve) => { finishStart = resolve; }));
  const running = runMain({ env, ...f });
  f.processControl.emit('SIGTERM');
  f.processControl.emit('SIGINT');
  expect(f.close).not.toHaveBeenCalled();
  finishStart({ close: f.close });
  await running;
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.processControl.exitCode).toBe(0);
});

test('rechaza configuración inválida antes de abrir conexiones y no imprime credenciales', async () => {
  const f = setup();
  await runMain({ env: { ...env, REDIS_URL: '' }, ...f });
  expect(f.bootstrap).not.toHaveBeenCalled();
  expect(f.processControl.exitCode).toBe(1);
  expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain('secret');
  expect(f.logger.error).toHaveBeenCalledWith('Falló el arranque del middleware.',
    expect.objectContaining({ timestamp: expect.any(String), detail: 'Falta configurar REDIS_URL.' }));
});

test('fallo de cierre produce código de salida distinto de cero', async () => {
  const f = setup();
  f.close.mockRejectedValueOnce(new Error('secret')); 
  await runMain({ env, ...f });
  f.processControl.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.processControl.exitCode).toBe(1);
  expect(f.logger.error).toHaveBeenCalledWith('Falló el apagado del middleware.',
    expect.objectContaining({ errorName: 'Error', timestamp: expect.any(String) }));
  expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain('secret');
});
