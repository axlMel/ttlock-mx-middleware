export type FsmState =
  | 'PENDING' | 'CONFIGURING' | 'AWAITING_ACK'
  | 'IN_ZONE' | 'AWAITING_EXIT_ALERT' | 'COMPLETED';

export interface PendingRequest {
  idempotencyKey: string;
  body: { companyId: number; unitId: string; comando: string };
}

export interface RouteState {
  assignmentId: number;
  companyId: number;
  apiCompanyId: number;
  unitId: number;
  deviceId: number;
  model: 'GV300W' | 'GV310LAU';
  catalogRouteId: number;
  routeType: 0 | 1;
  fsmState: FsmState;
  currentPointId: number | null;
  completedPointIds: number[];
  stepSeq: number;
  transmissionSeq: number;
  retryCount: number;
  pendingRequest: PendingRequest | null;
  lastAcceptedCommand: string | null;
  ackDeadline: string | null;
  closing: null | { reason: 'ROUTE_DONE' | 'ASSIGNMENT_ENDED'; finalEstado: number | null };
  startedAt: string;
  updatedAt: string;
}

export interface ChainCursor {
  partition: string;
  dtTrama: string | null;
  recentIds: number[];
}

export interface CatalogEntry<T> {
  value: T;
  dtModificacion: string | null;
  fetchedAt: string;
}

export class CorruptStateError extends Error {
  constructor(public readonly key: string, options?: ErrorOptions) {
    super(`Valor JSON corrupto en la llave ${key}`, options);
    this.name = 'CorruptStateError';
  }
}
