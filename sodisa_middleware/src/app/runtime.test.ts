import { ConfigError, type AppConfig } from '../config';
import type { Logger } from '../orchestrator';
import { buildApp } from './buildApp';
import { runProcess, type ProcessPort } from './runtime';
import type { App, AppFactories } from './types';

jest.mock('./buildApp', () => ({ buildApp: jest.fn() }));

function fixture() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const port: ProcessPort = { on: (event, listener) => { listeners.set(event, listener); }, exit: jest.fn(), exitCode: undefined };
  const logger: Logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const factories = { now: () => Date.parse('2026-11-17T12:00:00Z') } as AppFactories;
  const app: App = { start: jest.fn(async () => undefined), shutdown: jest.fn(async () => undefined) };
  jest.mocked(buildApp).mockReturnValue(app);
  const emit = (event: string, error?: unknown): void => { listeners.get(event)?.(error); };
  return { port, logger, factories, app, emit };
}
beforeEach(() => jest.clearAllMocks());

test('configuración inválida sale 78 y no construye la aplicación', async () => {
  const h = fixture();
  await runProcess(() => { throw new ConfigError(['DATABASE_URL: falta la credencial.']); },
    h.port, h.logger, h.factories);
  expect(h.port.exitCode).toBe(78);
  expect(buildApp).not.toHaveBeenCalled();
  expect(h.logger.error).toHaveBeenCalledWith('config_invalid', expect.objectContaining({
    reason: expect.stringContaining('DATABASE_URL') }));
});

test('fallo de arranque sale 1 y pide apagado sin imprimir la causa cruda', async () => {
  const h = fixture();
  jest.mocked(h.app.start).mockRejectedValueOnce(new Error('DB_SECRET_MARKER'));
  await runProcess(() => ({} as AppConfig), h.port, h.logger, h.factories);
  expect(h.port.exitCode).toBe(1);
  expect(h.app.shutdown).toHaveBeenCalledWith('startup_failed');
  expect(JSON.stringify(jest.mocked(h.logger.error).mock.calls)).not.toContain('DB_SECRET_MARKER');
});

test('SIGTERM durante el arranque espera y apaga una sola vez; segunda señal fuerza salida', async () => {
  const h = fixture();
  let release!: () => void;
  jest.mocked(h.app.start).mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
  const running = runProcess(() => ({} as AppConfig), h.port, h.logger, h.factories);
  h.emit('SIGTERM');
  release();
  await running;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(h.app.shutdown).toHaveBeenCalledTimes(1);
  expect(h.port.exitCode).toBe(0);
  h.emit('SIGINT');
  expect(h.port.exit).toHaveBeenCalledWith(1);
  expect(h.app.shutdown).toHaveBeenCalledTimes(1);
});

test('fallo de shutdown tras señal sale 1; errores no capturados fuerzan salida', async () => {
  const h = fixture();
  jest.mocked(h.app.shutdown).mockRejectedValueOnce(new Error('secret'));
  await runProcess(() => ({} as AppConfig), h.port, h.logger, h.factories);
  h.emit('SIGINT');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(h.port.exitCode).toBe(1);
  h.emit('uncaughtException', new Error('API_SECRET_MARKER'));
  h.emit('unhandledRejection', new Error('DB_SECRET_MARKER'));
  expect(h.port.exit).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(jest.mocked(h.logger.error).mock.calls)).not.toContain('API_SECRET_MARKER');
  expect(JSON.stringify(jest.mocked(h.logger.error).mock.calls)).not.toContain('DB_SECRET_MARKER');
});
