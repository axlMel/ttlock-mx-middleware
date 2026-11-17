import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import type { Scheduler, StepTask } from './types';

// BullMQ no admite ':' en un jobId personalizado. Los ids lógicos siguen intactos fuera de este adaptador.
export function bullJobId(logicalId: string): string {
  return logicalId.replaceAll(':', '-');
}

export class BullMqScheduler implements Scheduler {
  private readonly queue: Queue<StepTask>;
  private readonly worker: Worker<StepTask>;
  private handler: (task: StepTask) => Promise<void> = async () => undefined;
  private readonly activeIds = new Set<string>();
  private readonly deferred = new Map<string, { delayMs: number; task: StepTask }>();

  constructor(name: string, connection: Redis) {
    this.queue = new Queue<StepTask>(name, { connection });
    this.worker = new Worker<StepTask>(name, async (job) => {
      this.activeIds.add(job.id!);
      try { await this.handler(job.data); }
      finally { this.activeIds.delete(job.id!); }
    }, { connection });
    this.worker.on('completed', (job) => {
      const pending = this.deferred.get(job.id!);
      if (!pending) return;
      this.deferred.delete(job.id!);
      void this.queue.add('step', pending.task, { jobId: job.id, delay: pending.delayMs,
        removeOnComplete: true, removeOnFail: true }).catch(() => console.error('Error al reprogramar temporizador.'));
    });
    this.worker.on('error', () => { console.error('Error del trabajador de temporizadores.'); });
  }
  onTask(handler: (task: StepTask) => Promise<void>): void { this.handler = handler; }
  async schedule(jobId: string, delayMs: number, task: StepTask): Promise<void> {
    const id = bullJobId(jobId);
    if (this.activeIds.has(id)) { this.deferred.set(id, { delayMs: Math.max(0, delayMs), task }); return; }
    await this.queue.add('step', task, { jobId: id, delay: Math.max(0, delayMs),
      removeOnComplete: true, removeOnFail: true });
  }
  async cancel(jobId: string): Promise<void> {
    const id = bullJobId(jobId);
    this.deferred.delete(id);
    const job = await this.queue.getJob(id);
    if (job) await job.remove();
  }
  async close(): Promise<void> { await this.worker.close(); await this.queue.close(); }
}
