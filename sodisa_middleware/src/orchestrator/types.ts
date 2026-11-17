import type { AssignmentDetector, ChainReader } from '../detectors';
import type { DeviceDirectory, RoutePlanRepository } from '../catalog';
import type { CommandGateway } from '../gateway';
import type { RouteStateStore, ChainCursorStore, RouteState } from '../persistence';

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
export interface OrchestratorOptions {
  enabledCompanies: Map<number, number>;
  startMarginMinutes: number; pollIntervalMsRoutes: number; pollIntervalMsAck: number;
  ackRetryBackoffMs: number; ackMaxRetries: number; ackResendEnabled: boolean; dryRun: boolean;
  now?: () => number;
}
export type StepTask =
  | { kind: 'ACK_DEADLINE'; assignmentId: number; stepSeq: number; transmissionSeq: number }
  | { kind: 'API_RETRY'; assignmentId: number; stepSeq: number; transmissionSeq: number; attempt: number };
export interface Scheduler {
  schedule(jobId: string, delayMs: number, task: StepTask): Promise<void>;
  cancel(jobId: string): Promise<void>;
  onTask(handler: (task: StepTask) => Promise<void>): void;
  close(): Promise<void>;
}
export interface OrchestratorDeps {
  detectors: { assignments: AssignmentDetector; chains: ChainReader };
  catalog: { devices: DeviceDirectory; plans: RoutePlanRepository };
  gateway: CommandGateway;
  routeStates: RouteStateStore; cursors: ChainCursorStore;
  scheduler: Scheduler; logger: Logger;
}
export interface Orchestrator { start(): Promise<void>; stop(): Promise<void> }
export type TransitionEvent =
  | { kind: 'GATEWAY_ACCEPTED'; at: number; backoffMs: number; dryRun: boolean; command: string }
  | { kind: 'ACK'; serial: string }
  | { kind: 'ENTER'; geofenceId: number }
  | { kind: 'EXIT'; geofenceId: number; nextPointId: number | null }
  | { kind: 'ACK_DEADLINE'; at: number; backoffMs: number; resend: boolean; dryRun: boolean }
  | { kind: 'ASSIGNMENT_ENDED'; finalEstado: number | null };
export type TransitionEffect = 'SCHEDULE_ACK' | 'CANCEL_TIMERS' | 'TRANSMIT' | 'DELETE' | 'DEBUG';
export interface TransitionResult { state: RouteState | null; effects: TransitionEffect[] }
