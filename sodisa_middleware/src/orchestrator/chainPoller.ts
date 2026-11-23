import { decodeFrame, parseMessage } from '../protocol';
import { describeError } from '../common';
import type { RouteState } from '../persistence';
import { transition } from './transition';
import { StepRunner } from './stepRunner';
import { KeyedMutex } from './keyedMutex';
import type { OrchestratorDeps, OrchestratorOptions } from './types';

export class ChainPoller {
  private readonly nextPollAt = new Map<number, number>();
  private readonly backlog = new Set<number>();
  private lastTurnAt: number | null = null;
  private lastSummaryAt: number | null = null;
  private lastSaturationAt: number | null = null;
  private maxLagMs: number | null = null;
  private devices = 0;

  constructor(private readonly deps: OrchestratorDeps, private readonly opts: OrchestratorOptions,
    private readonly unitIndex: Map<number, number>, private readonly runner: StepRunner, private readonly mutex: KeyedMutex) {}
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private waiting(state: RouteState): boolean {
    return (state.fsmState === 'CONFIGURING' && state.pendingRequest !== null) ||
      state.fsmState === 'AWAITING_ACK' || state.fsmState === 'IN_ZONE' || state.fsmState === 'AWAITING_EXIT_ALERT';
  }
  private effectiveIntervalMs(): number {
    return Math.max(this.opts.chainPollIntervalMs,
      this.devices * Math.max(1000 / this.opts.chainMaxQueriesPerSecond, this.deps.chainQueryLimiter.minimumSpacingMs()));
  }
  private turnSpacingMs(): number {
    if (this.backlog.size) return this.deps.chainQueryLimiter.minimumSpacingMs();
    return this.devices ? Math.max(this.opts.chainPollIntervalMs / this.devices,
      this.deps.chainQueryLimiter.minimumSpacingMs()) : this.opts.chainPollIntervalMs;
  }
  nextDelay(): number {
    if (!this.devices || this.nextPollAt.size === 0) return 1000;
    const earliest = Math.min(...this.nextPollAt.values());
    const spacingAt = this.lastTurnAt === null ? this.now() : this.lastTurnAt + this.turnSpacingMs();
    return Math.max(0, Math.min(1000, Math.max(earliest, spacingAt) - this.now()));
  }
  private report(): void {
    const now = this.now();
    if (this.lastSummaryAt === null) this.lastSummaryAt = now;
    if (now - this.lastSummaryAt < 60_000) return;
    this.lastSummaryAt = now;
    this.deps.logger.info('chain_poll_summary', { timestamp: new Date(now).toISOString(), devices: this.devices,
      ...this.deps.chainQueryLimiter.takeStats(), maxLagMs: this.maxLagMs,
      effectiveIntervalMs: this.effectiveIntervalMs() });
    this.maxLagMs = null;
  }
  private async poll(state: RouteState): Promise<void> {
    await this.mutex.run(state.assignmentId, async () => {
      let cursor = await this.deps.cursors.get(state.deviceId);
      if (!cursor) {
        cursor = await this.deps.detectors.chains.initCursor(state.deviceId);
        await this.deps.cursors.set(state.deviceId, cursor);
      }
      const result = await this.deps.detectors.chains.readNew(state.deviceId, cursor);
      for (const frame of [...result.frames].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
        const lag = this.now() - Date.parse(frame.receivedAt.replace(' ', 'T') + 'Z');
        if (Number.isFinite(lag)) this.maxLagMs = Math.max(this.maxLagMs ?? 0, lag);
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
          this.deps.logger.debug('frame_ignored', { timestamp: new Date(this.now()).toISOString(),
            deviceId: current.deviceId, routeId: current.assignmentId });
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
      if (result.hasMore) this.backlog.add(state.deviceId);
      else this.backlog.delete(state.deviceId);
      this.nextPollAt.set(state.deviceId, result.hasMore ? this.now() + 1 : this.now() + this.opts.chainPollIntervalMs);
    });
  }
  async run(): Promise<void> {
    const now = this.now();
    const waiting = (await this.deps.routeStates.list()).filter((state) => this.waiting(state));
    const ids = new Set(waiting.map((state) => state.deviceId));
    for (const id of this.nextPollAt.keys()) if (!ids.has(id)) { this.nextPollAt.delete(id); this.backlog.delete(id); }
    for (const state of waiting) if (!this.nextPollAt.has(state.deviceId)) this.nextPollAt.set(state.deviceId, now);
    this.devices = ids.size;
    const effectiveIntervalMs = this.effectiveIntervalMs();
    if (this.devices / this.opts.chainPollIntervalMs > this.opts.chainMaxQueriesPerSecond / 1000 &&
      (this.lastSaturationAt === null || now - this.lastSaturationAt >= 60_000)) {
      this.lastSaturationAt = now;
      this.deps.logger.warn('chain_poll_saturated', { timestamp: new Date(now).toISOString(), devices: this.devices,
        effectiveIntervalMs });
    }
    this.report();
    const due = waiting.filter((state) => (this.nextPollAt.get(state.deviceId) ?? Infinity) <= now)
      .sort((a, b) => (this.nextPollAt.get(a.deviceId)! - this.nextPollAt.get(b.deviceId)!) || a.deviceId - b.deviceId)[0];
    if (!due || (this.lastTurnAt !== null && now < this.lastTurnAt + this.turnSpacingMs())) return;
    this.lastTurnAt = now;
    try { await this.poll(due); }
    catch (error) {
      this.backlog.delete(due.deviceId);
      this.nextPollAt.set(due.deviceId, this.now() + this.opts.chainPollIntervalMs);
      this.deps.logger.error('chain_poll_failed', { timestamp: new Date(this.now()).toISOString(),
        deviceId: due.deviceId, routeId: due.assignmentId, ...describeError(error) });
    }
  }
}
