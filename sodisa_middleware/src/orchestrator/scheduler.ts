import type { Scheduler, StepTask } from './types';

export class FakeScheduler implements Scheduler {
  private readonly jobs = new Map<string, { at: number; task: StepTask }>();
  private handler: (task: StepTask) => Promise<void> = async () => undefined;
  constructor(private time = 0) {}
  onTask(handler: (task: StepTask) => Promise<void>): void { this.handler = handler; }
  async schedule(jobId: string, delayMs: number, task: StepTask): Promise<void> {
    if (!this.jobs.has(jobId)) this.jobs.set(jobId, { at: this.time + delayMs, task });
  }
  async cancel(jobId: string): Promise<void> { this.jobs.delete(jobId); }
  async close(): Promise<void> { this.jobs.clear(); }
  count(): number { return this.jobs.size; }
  async advance(ms: number): Promise<void> {
    this.time += ms;
    for (const [id, job] of [...this.jobs]) {
      if (job.at <= this.time) { this.jobs.delete(id); await this.handler(job.task); }
    }
  }
}
