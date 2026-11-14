export type DomainEvent =
  | { type: 'ASSIGNMENT_DETECTED'; deviceId: string; routeId: string }
  | { type: 'STEP_READY' }
  | { type: 'COMMAND_SENT'; sentAt: string }
  | { type: 'COMMAND_RESENT'; sentAt: string }
  | { type: 'ACK'; siteCount: number }
  | { type: 'BATCH_EXHAUSTED' }
  | { type: 'ZONE_ENTER' }
  | { type: 'ZONE_EXIT'; siteCount: number };

export interface JobData {
  deviceId?: string;
  routeId?: string;
  siteIndex?: number;
  batchNo?: number;
  previousDelayMs?: number;
  bootstrap?: boolean;
}

export type JobName = 'poll-routes' | 'poll-reports' | 'send-command';

export interface JobOptions {
  delay?: number;
  jobId?: string;
  attempts?: number;
  backoff?: { type: 'fixed'; delay: number };
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
}

export interface JobQueue {
  add(name: JobName, data: JobData, options?: JobOptions): Promise<void>;
  hasPending(name: JobName, deviceId?: string, siteIndex?: number): Promise<boolean>;
  cancelPending(name: JobName, deviceId: string, siteIndex: number): Promise<void>;
}

export interface JobContext {
  name: JobName;
  data: JobData;
  attemptsMade: number;
  attempts: number;
}

export interface OrchestratorLogger {
  debug(message: string, fields: Record<string, unknown>): void;
  info(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
  error(message: string, fields: Record<string, unknown>): void;
}

export interface OrchestratorConfig {
  pollIntervalRoutesMs: number;
  pollIntervalAckMs: number;
  ackMaxRetries: number;
  ackRetryBackoffMs: number;
}

