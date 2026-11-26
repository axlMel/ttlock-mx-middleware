import { AuditUnavailableError, type GatewayRequest } from '../gateway';
import { isActiveAssignment } from '../detectors';
import type { RouteState } from '../persistence';
import { transition } from './transition';
import type { OrchestratorDeps, OrchestratorOptions, StepTask } from './types';

export const ackJobId = (state: RouteState): string => `ack:${state.assignmentId}:${state.stepSeq}:${state.transmissionSeq}`;
export const apiJobId = (state: RouteState, attempt: number): string => `api:${state.assignmentId}:${state.stepSeq}:${state.transmissionSeq}:${attempt}`;

export class StepRunner {
  private readonly jobs = new Map<number, Set<string>>();
  constructor(private readonly deps: OrchestratorDeps, private readonly opts: OrchestratorOptions,
    private readonly commandFor: (state: RouteState) => Promise<string>) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }
  private fields(state: RouteState): Record<string, unknown> {
    return { timestamp: new Date(this.now()).toISOString(), deviceId: state.deviceId, routeId: state.assignmentId,
      stepSeq: state.stepSeq, transmissionSeq: state.transmissionSeq };
  }
  private async save(state: RouteState): Promise<void> {
    await this.deps.routeStates.set({ ...state, updatedAt: new Date(this.now()).toISOString() });
    this.deps.logger.info('route_transition', this.fields(state));
  }
  private async schedule(id: string, delay: number, task: StepTask): Promise<void> {
    await this.deps.scheduler.schedule(id, Math.max(0, delay), task);
    const jobs = this.jobs.get(task.assignmentId) ?? new Set<string>();
    jobs.add(id);
    this.jobs.set(task.assignmentId, jobs);
  }
  async cancel(assignmentId: number): Promise<void> {
    for (const id of this.jobs.get(assignmentId) ?? []) await this.deps.scheduler.cancel(id);
    this.jobs.delete(assignmentId);
  }

  async send(state: RouteState, attempt = 0): Promise<void> {
    let current = state;
    if (current.fsmState === 'PENDING' || (current.fsmState === 'CONFIGURING' && !current.pendingRequest)) {
      let command: string;
      try { command = current.transmissionSeq > 1 && current.lastAcceptedCommand
        ? current.lastAcceptedCommand : await this.commandFor(current); }
      catch {
        this.deps.logger.warn('command_build_failed', this.fields(current));
        await this.schedule(apiJobId(current, attempt + 1), Math.min(60_000, 1000 * 2 ** Math.min(attempt, 20)),
          { kind: 'API_RETRY', assignmentId: current.assignmentId, stepSeq: current.stepSeq,
            transmissionSeq: current.transmissionSeq, attempt: attempt + 1 });
        return;
      }
      if (current.transmissionSeq > 1 && !current.lastAcceptedCommand) this.deps.logger.warn('accepted_command_missing_rebuilt', this.fields(current));
      const transmissionSeq = current.transmissionSeq === 0 ? 1 : current.transmissionSeq;
      current = { ...current, fsmState: 'CONFIGURING', transmissionSeq,
        firstTransmissionAt: current.firstTransmissionAt ?? (current.transmissionSeq === 0 ? new Date(this.now()).toISOString() : null),
        pendingRequest: { idempotencyKey: `${current.assignmentId}-${current.stepSeq}-${transmissionSeq}`,
          body: { companyId: current.apiCompanyId, unitId: String(current.unitId), comando: command } } };
      await this.save(current);
    }
    if (!current.pendingRequest) return;
    const pending = current.pendingRequest;
    const request: GatewayRequest = { assignmentId: current.assignmentId, deviceId: current.deviceId, unitId: current.unitId,
      apiCompanyId: pending.body.companyId, stepSeq: current.stepSeq, transmissionSeq: current.transmissionSeq,
      idempotencyKey: pending.idempotencyKey, command: pending.body.comando };
    let result;
    try { result = await this.deps.gateway.send(request); }
    catch (error) {
      this.deps.logger.warn(error instanceof AuditUnavailableError ? 'audit_unavailable' : 'gateway_unexpected', this.fields(current));
      result = { kind: 'UNCERTAIN' as const, cause: 'network' as const };
    }
    if (result.kind === 'ACCEPTED' || result.kind === 'DRY_RUN') {
      const next = transition(current, { kind: 'GATEWAY_ACCEPTED', at: this.now(), backoffMs: this.opts.ackRetryBackoffMs,
        dryRun: this.opts.dryRun, command: pending.body.comando });
      if (!next.state) return;
      await this.save(next.state);
      if (result.kind === 'ACCEPTED' && result.apiStatus === 'OUTCOME_UNKNOWN') this.deps.logger.warn('outcome_unknown', this.fields(current));
      if (next.effects.includes('SCHEDULE_ACK')) await this.schedule(ackJobId(next.state), this.opts.ackRetryBackoffMs,
        { kind: 'ACK_DEADLINE', assignmentId: next.state.assignmentId, stepSeq: next.state.stepSeq, transmissionSeq: next.state.transmissionSeq });
      return;
    }
    const nextAttempt = attempt + 1;
    const definitive = result.kind === 'DEFINITIVE_ERROR';
    if (definitive || nextAttempt >= 3) this.deps.logger.warn(definitive ? 'gateway_definitive_error' : 'gateway_retry', this.fields(current));
    const delay = definitive ? 300_000 : Math.min(60_000, 1000 * 2 ** Math.min(attempt, 20));
    await this.schedule(apiJobId(current, nextAttempt), delay, { kind: 'API_RETRY', assignmentId: current.assignmentId,
      stepSeq: current.stepSeq, transmissionSeq: current.transmissionSeq, attempt: nextAttempt });
  }

  async onTask(task: StepTask): Promise<void> {
    const state = await this.deps.routeStates.get(task.assignmentId);
    if (!state || state.stepSeq !== task.stepSeq || state.transmissionSeq !== task.transmissionSeq) return;
    if (task.kind === 'API_RETRY') {
      if (state.fsmState === 'PENDING' || state.fsmState === 'CONFIGURING') await this.send(state, task.attempt);
      return;
    }
    if (state.fsmState !== 'AWAITING_ACK' || this.opts.dryRun) return;
    if (!state.ackDeadline || this.now() < Date.parse(state.ackDeadline)) return;
    if (!this.opts.ackResendEnabled) {
      this.deps.logger.warn('ack_window_expired', this.fields(state));
      await this.schedule(`${ackJobId(state)}:warn:${this.now()}`, this.opts.ackRetryBackoffMs,
        { kind: 'ACK_DEADLINE', assignmentId: state.assignmentId, stepSeq: state.stepSeq, transmissionSeq: state.transmissionSeq });
      return;
    }
    if (!task.safeguard) {
      const acceptedAt = state.lastAcceptedAt ? Date.parse(state.lastAcceptedAt)
        : Date.parse(state.ackDeadline) - this.opts.ackRetryBackoffMs;
      const safeguardAt = Math.max(Date.parse(state.ackDeadline), acceptedAt + 2 * this.opts.chainPollIntervalMs);
      await this.schedule(`${ackJobId(state)}:safeguard`, safeguardAt - this.now(),
        { kind: 'ACK_DEADLINE', assignmentId: state.assignmentId, stepSeq: state.stepSeq,
          transmissionSeq: state.transmissionSeq, safeguard: true });
      return;
    }
    await this.resend(state);
  }

  async resendAfterRead(state: RouteState): Promise<void> {
    if (this.opts.dryRun || !this.opts.ackResendEnabled || state.fsmState !== 'AWAITING_ACK' ||
      !state.ackDeadline || this.now() < Date.parse(state.ackDeadline)) return;
    const current = await this.deps.routeStates.get(state.assignmentId);
    if (!current || current.fsmState !== 'AWAITING_ACK' || current.stepSeq !== state.stepSeq ||
      current.transmissionSeq !== state.transmissionSeq || current.ackDeadline !== state.ackDeadline) return;
    await this.resend(current);
  }

  private async resend(state: RouteState): Promise<void> {
    if (!state.closing) {
      const assignment = await this.deps.detectors.assignments.getById(state.assignmentId);
      if (!assignment || !isActiveAssignment(assignment)) return;
    }
    const next = transition(state, { kind: 'ACK_DEADLINE', at: this.now(), backoffMs: this.opts.ackRetryBackoffMs,
      resend: true, dryRun: this.opts.dryRun });
    if (!next.state || next.state === state) return;
    await this.save(next.state);
    if (this.opts.ackMaxRetries > 0 && next.state.retryCount % this.opts.ackMaxRetries === 0)
      this.deps.logger.warn('ack_retry_batch_exhausted', { ...this.fields(next.state), batch: next.state.retryCount / this.opts.ackMaxRetries });
    await this.send(next.state);
  }

  async resume(state: RouteState): Promise<void> {
    if (state.fsmState === 'PENDING' || state.fsmState === 'CONFIGURING') await this.send(state);
    else if (state.fsmState === 'AWAITING_ACK' && !this.opts.dryRun && state.ackDeadline) {
      await this.schedule(ackJobId(state), Date.parse(state.ackDeadline) - this.now(),
        { kind: 'ACK_DEADLINE', assignmentId: state.assignmentId, stepSeq: state.stepSeq, transmissionSeq: state.transmissionSeq });
    }
  }
}
