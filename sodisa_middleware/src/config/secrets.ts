import { join } from 'node:path';

export interface SecretResult { value: string | null; issue: string | null }

export function readSecret(env: Record<string, string | undefined>, readFile: (path: string) => string,
  directory: string | undefined, filename: string, variable: string): SecretResult {
  if (directory?.trim()) {
    const path = join(directory, filename);
    try {
      const value = readFile(path).trim();
      return value ? { value, issue: null } : { value: null, issue: `${variable}: el archivo de credencial está vacío.` };
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'))
        return { value: null, issue: `${variable}: no se pudo leer el archivo de credencial ${path}.` };
    }
  }
  const value = env[variable]?.trim();
  return value ? { value, issue: null } : { value: null, issue: `${variable}: falta la credencial (archivo ${filename} o variable de entorno).` };
}
