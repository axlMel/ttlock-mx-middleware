import type { RouteState } from '../persistence/types';
import type { DomainEvent } from './types';

export function transition(state: RouteState | null, event: DomainEvent): RouteState | null {
  if (state === null) {
    return event.type === 'ASSIGNMENT_DETECTED'
      ? {
          deviceId: event.deviceId,
          routeId: event.routeId,
          currentSiteIndex: 0,
          fsmState: 'PENDING',
          lastCommandSentAt: null,
          retryCount: 0,
        }
      : null;
  }

  switch (event.type) {
    case 'STEP_READY':
      return state.fsmState === 'PENDING' ? { ...state, fsmState: 'CONFIGURING' } : state;
    case 'COMMAND_SENT':
      return state.fsmState === 'CONFIGURING'
        ? { ...state, fsmState: 'AWAITING_ACK', lastCommandSentAt: event.sentAt }
        : state;
    case 'COMMAND_RESENT':
      return state.fsmState === 'AWAITING_ACK'
        ? { ...state, lastCommandSentAt: event.sentAt, retryCount: state.retryCount + 1 }
        : state;
    case 'ACK':
      if (state.fsmState !== 'AWAITING_ACK') return state;
      if (state.currentSiteIndex < event.siteCount) return { ...state, fsmState: 'IN_ZONE' };
      if (state.currentSiteIndex === event.siteCount) return { ...state, fsmState: 'COMPLETED' };
      return state;
    case 'BATCH_EXHAUSTED':
      return state;
    case 'ZONE_ENTER':
      return state.fsmState === 'IN_ZONE' ? { ...state, fsmState: 'AWAITING_EXIT_ALERT' } : state;
    case 'ZONE_EXIT':
      if (state.fsmState !== 'IN_ZONE' && state.fsmState !== 'AWAITING_EXIT_ALERT') return state;
      if (state.currentSiteIndex + 1 < event.siteCount) {
        return {
          ...state,
          currentSiteIndex: state.currentSiteIndex + 1,
          fsmState: 'PENDING',
          lastCommandSentAt: null,
          retryCount: 0,
        };
      }
      if (state.currentSiteIndex + 1 === event.siteCount) {
        return {
          ...state,
          currentSiteIndex: event.siteCount,
          fsmState: 'CONFIGURING',
          lastCommandSentAt: null,
          retryCount: 0,
        };
      }
      return state;
    case 'ASSIGNMENT_DETECTED':
      return state;
  }
}
