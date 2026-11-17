import type { RouteState } from '../persistence';
import { serialFor } from './serial';
import type { TransitionEvent, TransitionResult } from './types';

export function transition(state: RouteState, event: TransitionEvent): TransitionResult {
  const ignored = (): TransitionResult => ({ state, effects: ['DEBUG'] });
  if (event.kind === 'ASSIGNMENT_ENDED') {
    if (state.fsmState === 'COMPLETED' || (state.stepSeq < 1 && state.transmissionSeq < 1)) return { state: null, effects: ['CANCEL_TIMERS', 'DELETE'] };
    if (state.closing?.reason === 'ASSIGNMENT_ENDED') return ignored();
    return { state: { ...state, fsmState: 'PENDING', currentPointId: null, closing: { reason: 'ASSIGNMENT_ENDED', finalEstado: event.finalEstado },
      stepSeq: state.stepSeq + 1, transmissionSeq: 0, retryCount: 0, pendingRequest: null, lastAcceptedCommand: null, ackDeadline: null }, effects: ['CANCEL_TIMERS', 'TRANSMIT'] };
  }
  if (event.kind === 'GATEWAY_ACCEPTED') {
    if (state.fsmState !== 'CONFIGURING') return ignored();
    return { state: { ...state, fsmState: 'AWAITING_ACK', pendingRequest: null, lastAcceptedCommand: event.command,
      ackDeadline: event.dryRun ? null : new Date(event.at + event.backoffMs).toISOString() }, effects: event.dryRun ? [] : ['SCHEDULE_ACK'] };
  }
  if (event.kind === 'ACK') {
    if ((state.fsmState !== 'CONFIGURING' || !state.pendingRequest) && state.fsmState !== 'AWAITING_ACK') return ignored();
    if (event.serial !== serialFor(state.stepSeq)) return ignored();
    if (state.currentPointId === null) return state.closing?.reason === 'ASSIGNMENT_ENDED'
      ? { state: null, effects: ['CANCEL_TIMERS', 'DELETE'] }
      : { state: { ...state, fsmState: 'COMPLETED', pendingRequest: null, lastAcceptedCommand: null, ackDeadline: null }, effects: ['CANCEL_TIMERS'] };
    return { state: { ...state, fsmState: 'IN_ZONE', pendingRequest: null, lastAcceptedCommand: null, ackDeadline: null }, effects: ['CANCEL_TIMERS'] };
  }
  if (event.kind === 'ENTER') {
    if (event.geofenceId !== 0 || state.fsmState !== 'IN_ZONE' || state.currentPointId === null) return ignored();
    return { state: { ...state, fsmState: 'AWAITING_EXIT_ALERT' }, effects: [] };
  }
  if (event.kind === 'EXIT') {
    if (event.geofenceId !== 0 || (state.fsmState !== 'IN_ZONE' && state.fsmState !== 'AWAITING_EXIT_ALERT') || state.currentPointId === null) return ignored();
    const completedPointIds = [...state.completedPointIds, state.currentPointId];
    return { state: { ...state, fsmState: 'PENDING', completedPointIds, currentPointId: event.nextPointId,
      closing: event.nextPointId === null ? { reason: 'ROUTE_DONE', finalEstado: null } : null,
      stepSeq: state.stepSeq + 1, transmissionSeq: 0, retryCount: 0, pendingRequest: null, lastAcceptedCommand: null, ackDeadline: null }, effects: ['TRANSMIT'] };
  }
  if (event.kind === 'ACK_DEADLINE') {
    if (state.fsmState !== 'AWAITING_ACK' || event.dryRun || !state.ackDeadline || Date.parse(state.ackDeadline) > event.at) return ignored();
    if (!event.resend) return { state: { ...state, ackDeadline: new Date(event.at + event.backoffMs).toISOString() }, effects: ['SCHEDULE_ACK'] };
    return { state: { ...state, fsmState: 'CONFIGURING', transmissionSeq: state.transmissionSeq + 1,
      retryCount: state.retryCount + 1, pendingRequest: null, ackDeadline: null }, effects: ['TRANSMIT'] };
  }
  return ignored();
}
