import type { Logger } from '../orchestrator';

export function createConsoleLogger(): Logger {
  const write = (level: 'debug' | 'info' | 'warn' | 'error', event: string,
    fields: Record<string, unknown> = {}): void => {
    console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }));
  };
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}
