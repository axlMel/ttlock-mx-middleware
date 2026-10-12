export type FsmState =
  | 'PENDING'
  | 'CONFIGURING'
  | 'AWAITING_ACK'
  | 'IN_ZONE'
  | 'AWAITING_EXIT_ALERT'
  | 'COMPLETED';

export interface RouteState {
  deviceId: string;
  routeId: string;
  currentSiteIndex: number;
  fsmState: FsmState;
  lastCommandSentAt: string | null;
  retryCount: number;
}
