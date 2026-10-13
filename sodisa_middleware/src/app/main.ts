import type { OrchestratorLogger } from '../orchestrator/types';
import { startApp, type AppHandle } from './bootstrap';
import { ConfigurationError, readAppConfig, type AppConfig } from './config';

interface ProcessControl {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void;
  exitCode?: number;
}

interface MainOptions {
  env?: NodeJS.ProcessEnv;
  logger?: OrchestratorLogger;
  processControl?: ProcessControl;
  bootstrap?: (config: AppConfig, logger: OrchestratorLogger) => Promise<AppHandle>;
  now?: () => string;
}

function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof ConfigurationError) return { detail: error.message };
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      errorName: error.name,
      ...(code && /^[A-Z0-9_]+$/.test(code) ? { code } : {}),
    };
  }
  return { errorName: 'UnknownError' };
}

export async function runMain(options: MainOptions = {}): Promise<void> {
  const logger = options.logger ?? console;
  const processControl = options.processControl ?? process;
  const bootstrap = options.bootstrap ?? ((config: AppConfig, appLogger: OrchestratorLogger) =>
    startApp(config, undefined, appLogger));
  const now = options.now ?? (() => new Date().toISOString());
  let handle: AppHandle | undefined;
  let requestedSignal: 'SIGINT' | 'SIGTERM' | undefined;
  let closing: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    closing ??= (async () => {
      if (!handle) return;
      logger.info('Iniciando apagado del middleware.', { timestamp: now(), signal: requestedSignal });
      try {
        await handle.close();
        processControl.exitCode = 0;
        logger.info('Middleware detenido.', { timestamp: now() });
      } catch (error) {
        processControl.exitCode = 1;
        logger.error('Falló el apagado del middleware.', { timestamp: now(), ...safeError(error) });
      }
    })();
    return closing;
  };

  const requestStop = (signal: 'SIGINT' | 'SIGTERM'): void => {
    requestedSignal ??= signal;
    if (handle) void stop();
  };
  processControl.on('SIGINT', () => requestStop('SIGINT'));
  processControl.on('SIGTERM', () => requestStop('SIGTERM'));

  try {
    const config = readAppConfig(options.env);
    logger.info('Iniciando middleware.', { timestamp: now() });
    handle = await bootstrap(config, logger);
    logger.info('Worker disponible; trabajo inicial programado.', { timestamp: now() });
    if (requestedSignal) await stop();
  } catch (error) {
    processControl.exitCode = 1;
    logger.error('Falló el arranque del middleware.', { timestamp: now(), ...safeError(error) });
  }
}

if (require.main === module) {
  void runMain();
}
