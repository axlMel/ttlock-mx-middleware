import { isActiveAssignment, type AssignmentRow } from '../detectors';
import { describeError } from '../common';
import type { RouteState } from '../persistence';
import { transition } from './transition';
import { StepRunner } from './stepRunner';
import { KeyedMutex } from './keyedMutex';
import type { OrchestratorDeps, OrchestratorOptions } from './types';

export class AssignmentCycle {
  private delay: number;
  private readonly unorderedAlerted = new Set<number>();
  private readonly pendingStarts = new Map<number, Promise<void>>();
  private readonly pendingUnits = new Set<number>();
  private readonly deferredFailures = new Set<number>();
  private stopping = false;
  constructor(private readonly deps: OrchestratorDeps, private readonly opts: OrchestratorOptions,
    private readonly unitIndex: Map<number, number>, private readonly runner: StepRunner, private readonly mutex: KeyedMutex) {
    this.delay = opts.pollIntervalMsRoutes;
  }
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private fields(assignmentId: number, deviceId: number): Record<string, unknown> {
    return { timestamp: new Date(this.now()).toISOString(), routeId: assignmentId, deviceId };
  }
  nextDelay(): number { return this.delay; }
  async waitPending(): Promise<void> { await Promise.all([...this.pendingStarts.values()]); }
  async stop(): Promise<void> { this.stopping = true; await this.waitPending(); }

  async run(): Promise<void> {
    let changed = false;
    let failed = false;
    let pollLogged = false;
    const previousFailures = new Set(this.deferredFailures);
    this.deferredFailures.clear();
    const failedAssignments = new Set<number>();
    const assignmentFailed = (assignmentId: number, companyId: number, deviceId: number,
      stage: string, error: unknown): void => {
      failed = true;
      failedAssignments.add(assignmentId);
      if (pollLogged) this.deferredFailures.add(assignmentId);
      this.deps.logger.error('assignment_failed', { ...this.fields(assignmentId, deviceId), assignmentId,
        companyId, stage, ...describeError(error) });
    };
    const assignments: AssignmentRow[] = [];
    for (const companyId of this.opts.enabledCompanies.keys()) {
      try { assignments.push(...await this.deps.detectors.assignments.listVigentes(companyId)); }
      catch (error) { failed = true; this.deps.logger.error('assignment_poll_failed', {
        timestamp: new Date(this.now()).toISOString(), companyId, ...describeError(error) }); }
    }
    const vigente = new Map<number, AssignmentRow>();
    for (const row of assignments) {
      try { if (isActiveAssignment(row)) vigente.set(row.assignmentId, row); }
      catch (error) { assignmentFailed(row.assignmentId, row.companyId, 0, 'vigencia', error); }
    }
    for (const assignmentId of [...this.unorderedAlerted]) if (!vigente.has(assignmentId)) this.unorderedAlerted.delete(assignmentId);
    const states = await this.deps.routeStates.list();
    for (const state of states) {
      if (vigente.has(state.assignmentId)) {
        if (state.fsmState === 'PENDING' || (state.fsmState === 'CONFIGURING' && !state.pendingRequest)) {
          try {
            await this.mutex.run(state.assignmentId, async () => {
              const current = await this.deps.routeStates.get(state.assignmentId);
              if (current && (current.fsmState === 'PENDING' || (current.fsmState === 'CONFIGURING' && !current.pendingRequest)))
                await this.runner.send(current);
            });
          } catch (error) {
            assignmentFailed(state.assignmentId, state.companyId, state.deviceId, 'recuperación', error);
            this.deps.logger.error('route_resume_failed', { ...this.fields(state.assignmentId, state.deviceId), ...describeError(error) });
          }
        }
        continue;
      }
      try {
        await this.mutex.run(state.assignmentId, async () => {
        const current = await this.deps.routeStates.get(state.assignmentId);
        if (!current) return;
        if (current.closing?.reason === 'ASSIGNMENT_ENDED' &&
          (current.fsmState === 'PENDING' || (current.fsmState === 'CONFIGURING' && !current.pendingRequest))) {
          await this.runner.send(current);
          return;
        }
        const row = await this.deps.detectors.assignments.getById(current.assignmentId);
        if (row && isActiveAssignment(row)) return;
        const result = transition(current, { kind: 'ASSIGNMENT_ENDED', finalEstado: row?.estado ?? null });
        if (result.state === current) return;
        if (!result.state) {
          await this.deps.routeStates.delete(current.assignmentId);
          this.unitIndex.delete(current.unitId);
          await this.runner.cancel(current.assignmentId);
          await this.deps.cursors.delete(current.deviceId);
        } else {
          await this.deps.routeStates.set(result.state);
          await this.runner.cancel(current.assignmentId);
          await this.runner.send(result.state);
        }
        this.deps.logger.info('assignment_ended', { ...this.fields(current.assignmentId, current.deviceId), finalEstado: row?.estado ?? null });
        changed = true;
        });
      } catch (error) {
        assignmentFailed(state.assignmentId, state.companyId, state.deviceId, 'cierre', error);
        this.deps.logger.error('assignment_close_failed', { ...this.fields(state.assignmentId, state.deviceId), ...describeError(error) });
      }
    }
    const selected = new Map<number, AssignmentRow>();
    for (const row of assignments) {
      if (failedAssignments.has(row.assignmentId)) continue;
      try {
        if (!this.opts.enabledCompanies.has(row.companyId) || !isActiveAssignment(row)) continue;
        const previous = selected.get(row.unitId);
        if (!previous || row.horaInicial.getTime() < previous.horaInicial.getTime() ||
          (row.horaInicial.getTime() === previous.horaInicial.getTime() && row.assignmentId < previous.assignmentId)) selected.set(row.unitId, row);
      } catch (error) { assignmentFailed(row.assignmentId, row.companyId, 0, 'selección', error); }
    }
    for (const row of selected.values()) {
      try {
        const occupying = this.unitIndex.get(row.unitId);
        if (occupying !== undefined) {
          if (occupying !== row.assignmentId) this.deps.logger.warn('unit_already_in_route', this.fields(row.assignmentId, 0));
          continue;
        }
        if (this.pendingUnits.has(row.unitId) || this.pendingStarts.has(row.assignmentId) || this.stopping) continue;
        if (await this.deps.routeStates.get(row.assignmentId)) continue;
        this.pendingUnits.add(row.unitId);
        changed = true;
        const work = this.mutex.run(row.assignmentId, async () => {
        const device = await this.deps.catalog.devices.resolveForRouteStart(row.unitId, row.companyId);
        const plan = await this.deps.catalog.plans.getPlan(row.companyId, row.catalogRouteId, { forceFresh: true });
        if (plan.routeType === 1) {
          if (!this.unorderedAlerted.has(row.assignmentId)) this.deps.logger.warn('ROUTE_TYPE_UNORDERED_SKIPPED', this.fields(row.assignmentId, device.deviceId));
          this.unorderedAlerted.add(row.assignmentId);
          return;
        }
        const cursor = await this.deps.detectors.chains.initCursor(device.deviceId);
        if (this.stopping) return;
        const currentRow = await this.deps.detectors.assignments.getById(row.assignmentId);
        if (!currentRow || !isActiveAssignment(currentRow) || currentRow.unitId !== row.unitId ||
          this.unitIndex.has(row.unitId)) return;
        await this.deps.cursors.set(device.deviceId, cursor);
        const now = new Date(this.now()).toISOString();
        const state: RouteState = { assignmentId: row.assignmentId, companyId: row.companyId,
          apiCompanyId: this.opts.enabledCompanies.get(row.companyId)!, unitId: row.unitId,
          deviceId: device.deviceId, model: device.model, catalogRouteId: row.catalogRouteId, routeType: 0,
          fsmState: 'PENDING', currentPointId: plan.points[0].pointId, completedPointIds: [], stepSeq: 0,
          transmissionSeq: 0, retryCount: 0, pendingRequest: null, lastAcceptedCommand: null, ackDeadline: null, closing: null,
          startedAt: now, updatedAt: now };
        await this.deps.routeStates.set(state);
        this.unitIndex.set(row.unitId, row.assignmentId);
        await this.runner.send(state);
        }).catch((error: unknown) => {
          if (this.stopping) return;
          assignmentFailed(row.assignmentId, row.companyId, 0, 'inicio', error);
          this.deps.logger.error('assignment_start_failed', { ...this.fields(row.assignmentId, 0), ...describeError(error) });
        }).finally(() => {
          this.pendingStarts.delete(row.assignmentId);
          this.pendingUnits.delete(row.unitId);
        });
        this.pendingStarts.set(row.assignmentId, work);
      } catch (error) {
        assignmentFailed(row.assignmentId, row.companyId, 0, 'inicio', error);
        this.deps.logger.error('assignment_start_failed', { ...this.fields(row.assignmentId, 0), ...describeError(error) });
      }
    }
    this.delay = changed ? this.opts.pollIntervalMsRoutes : Math.min(this.opts.pollIntervalMsRoutes * 5, this.delay * 2);
    pollLogged = true;
    this.deps.logger.debug('assignment_poll', { timestamp: new Date(this.now()).toISOString(), source: 'assignments',
      count: assignments.length, failedAssignments: new Set([...failedAssignments, ...previousFailures]).size,
      nextDelayMs: this.delay, failed: failed || previousFailures.size > 0 });
  }
}
