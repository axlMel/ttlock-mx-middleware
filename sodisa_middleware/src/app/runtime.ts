import type { AppConfig } from '../config';
import { describeError } from '../common';
import { ConfigError } from '../config';
import type { Logger } from '../orchestrator';
import { buildApp } from './buildApp';
import type { App, AppFactories } from './types';

export interface ProcessPort {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code: number): void;
  exitCode?: string | number;
}

export async function runProcess(load: () => AppConfig, port: ProcessPort, logger: Logger,
  factories: AppFactories): Promise<void> {
  let app: App | null = null;
  let boot: Promise<void> | null = null;
  let stopping = false;
  let startupFailed = false;
  const timestamp = (): string => new Date(factories.now()).toISOString();
  const signal = (reason: string): void => {
    if (stopping) { port.exit(1); return; }
    stopping = true;
    void (async () => {
      try { await boot; } catch { startupFailed = true; }
      try { await app?.shutdown(reason); }
      catch { startupFailed = true; logger.error('shutdown_failed', { timestamp: timestamp(), reason: 'No se pudo cerrar el servicio.' }); }
      port.exitCode = startupFailed ? 1 : 0;
    })();
  };
  port.on('SIGTERM', () => signal('SIGTERM'));
  port.on('SIGINT', () => signal('SIGINT'));
  const fatal = (kind: string): void => {
    logger.error('fatal_process_error', { timestamp: timestamp(), kind, reason: 'Error no capturado; se reiniciará el servicio.' });
    port.exit(1);
  };
  port.on('uncaughtException', () => fatal('uncaughtException'));
  port.on('unhandledRejection', () => fatal('unhandledRejection'));
  try {
    const config = load();
    app = buildApp(config, logger, factories);
    boot = app.start();
    await boot;
  } catch (error) {
    startupFailed = true;
    if (error instanceof ConfigError) logger.error('config_invalid', { timestamp: timestamp(), reason: error.message });
    else {
      const { errorName, errorCode } = describeError(error);
      logger.error('startup_failed', { timestamp: timestamp(), reason: 'No se pudo iniciar el servicio.',
        errorName, ...(errorCode === undefined ? {} : { errorCode }) });
    }
    try { await app?.shutdown('startup_failed'); }
    catch { logger.error('shutdown_failed', { timestamp: timestamp(), reason: 'No se pudieron cerrar todos los recursos.' }); }
    port.exitCode = error instanceof ConfigError ? 78 : 1;
  }
}
