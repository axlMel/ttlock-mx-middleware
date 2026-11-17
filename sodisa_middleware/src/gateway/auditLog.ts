import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditRecord, CommandAuditLog } from './types';

export function createAuditLog(dir: string, opts: { now?: () => number } = {}): CommandAuditLog {
  let queue: Promise<void> = Promise.resolve();
  return {
    append(record: AuditRecord): Promise<void> {
      const write = async (): Promise<void> => {
        await mkdir(dir, { recursive: true });
        const day = new Date(opts.now?.() ?? Date.now()).toISOString().slice(0, 10);
        const file = await open(join(dir, `audit-${day}.jsonl`), 'a');
        try {
          await file.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
          if (record.phase === 'INTENT') await file.sync();
        } finally { await file.close(); }
      };
      const result = queue.then(write);
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
