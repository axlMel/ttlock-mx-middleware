import { decodeFrame, parseMessage } from '../protocol';
import { describeError } from '../common';
import type { RouteState } from '../persistence';
import { transition } from './transition';
import { StepRunner } from './stepRunner';
import { KeyedMutex } from './keyedMutex';
import type { OrchestratorDeps, OrchestratorOptions } from './types';

export class ChainPoller {
  constructor(private readonly deps: OrchestratorDeps, private readonly opts: OrchestratorOptions,
    private readonly unitIndex: Map<number, number>, private readonly runner: StepRunner, private readonly mutex: KeyedMutex) {}
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private waiting(state: RouteState): boolean {
    return (state.fsmState === 'CONFIGURING' && state.pendingRequest !== null) ||
      state.fsmState === 'AWAITING_ACK' || state.fsmState === 'IN_ZONE' || state.fsmState === 'AWAITING_EXIT_ALERT';
  }
  async run(): Promise<void> {
    const started = this.now();
    let queried = 0, rowsRead = 0, lagMs: number | null = null;
    for (const state of await this.deps.routeStates.list()) {
      if (!this.waiting(state)) continue;
      queried += 1;
      try {
        await this.mutex.run(state.assignmentId, async () => {
        let cursor = await this.deps.cursors.get(state.deviceId);
        if (!cursor) {
          cursor = await this.deps.detectors.chains.initCursor(state.deviceId);
          await this.deps.cursors.set(state.deviceId, cursor);
        }
        for (let batch = 0; batch < 5; batch += 1) {
          const result = await this.deps.detectors.chains.readNew(state.deviceId, cursor);
          rowsRead += result.frames.length;
          for (const frame of [...result.frames].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
            lagMs = this.now() - Date.parse(frame.receivedAt.replace(' ', 'T') + 'Z');
            const current = await this.deps.routeStates.get(state.assignmentId);
            if (!current) continue;
            const parsed = parseMessage(decodeFrame(frame.raw));
            if (parsed.kind === 'unknown') continue;
            let event;
            if (parsed.kind === 'ack') event = { kind: 'ACK' as const, serial: parsed.serial };
            else if (parsed.event === 'enter') event = { kind: 'ENTER' as const, geofenceId: parsed.geofenceId };
            else {
              if (parsed.geofenceId !== 0 || (current.fsmState !== 'IN_ZONE' && current.fsmState !== 'AWAITING_EXIT_ALERT')) continue;
              const plan = await this.deps.catalog.plans.getPlan(current.companyId, current.catalogRouteId, { forceFresh: true });
              const done = new Set([...current.completedPointIds, current.currentPointId]);
              const next = plan.points.find((point) => !done.has(point.pointId));
              event = { kind: 'EXIT' as const, geofenceId: parsed.geofenceId, nextPointId: next?.pointId ?? null };
            }
            const next = transition(current, event);
            if (next.state === current) {
              this.deps.logger.debug('frame_ignored', { timestamp: new Date(this.now()).toISOString(), deviceId: current.deviceId, routeId: current.assignmentId });
              continue;
            }
            if (next.state) await this.deps.routeStates.set({ ...next.state, updatedAt: new Date(this.now()).toISOString() });
            else {
              await this.deps.routeStates.delete(current.assignmentId);
              this.unitIndex.delete(current.unitId);
            }
            this.deps.logger.info('route_transition', { timestamp: new Date(this.now()).toISOString(), deviceId: current.deviceId,
              routeId: current.assignmentId, stepSeq: current.stepSeq, transmissionSeq: current.transmissionSeq });
            if (next.effects.includes('CANCEL_TIMERS')) await this.runner.cancel(current.assignmentId);
            if (next.effects.includes('TRANSMIT') && next.state) await this.runner.send(next.state);
          }
          if (await this.deps.routeStates.get(state.assignmentId)) await this.deps.cursors.set(state.deviceId, result.cursor);
          else await this.deps.cursors.delete(state.deviceId);
          cursor = result.cursor;
          if (!result.hasMore) break;
          if (batch < 4) await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        });
      } catch (error) {
        this.deps.logger.error('chain_poll_failed', { timestamp: new Date(this.now()).toISOString(),
          deviceId: state.deviceId, routeId: state.assignmentId, ...describeError(error) });
      }
    }
    this.deps.logger.debug('chain_poll', { timestamp: new Date(this.now()).toISOString(), source: 'chains', devices: queried,
      rows: rowsRead, durationMs: this.now() - started, lagMs });
  }
}
