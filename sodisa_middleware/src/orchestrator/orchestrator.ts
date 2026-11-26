import { buildGeoCommand, buildResetCommand, buildOutOffCommand, profileFor } from '../protocol';
import { describeError } from '../common';
import type { RouteState } from '../persistence';
import { AssignmentCycle } from './assignmentCycle';
import { ChainPoller } from './chainPoller';
import { KeyedMutex } from './keyedMutex';
import { serialFor } from './serial';
import { StepRunner } from './stepRunner';
import type { Orchestrator, OrchestratorDeps, OrchestratorOptions } from './types';

export function createOrchestrator(deps: OrchestratorDeps, opts: OrchestratorOptions): Orchestrator {
  const mutex = new KeyedMutex();
  const unitIndex = new Map<number, number>();
  const commandFor = async (state: RouteState): Promise<string> => {
    const profile = profileFor(state.model);
    const serial = serialFor(state.stepSeq);
    if (state.currentPointId === null) return state.closingPhase === 'OUT_OFF'
      ? buildOutOffCommand(profile, serial) : buildResetCommand(profile, serial);
    const plan = await deps.catalog.plans.getPlan(state.companyId, state.catalogRouteId);
    const point = plan.points.find((item) => item.pointId === state.currentPointId);
    if (!point) throw new Error(`Punto ${state.currentPointId} no disponible en el plan`);
    return buildGeoCommand(profile, { latitude: point.latitude, longitude: point.longitude,
      radiusM: point.radiusM, mode: 3, zoneId: 0, serial });
  };
  const runner = new StepRunner(deps, opts, commandFor);
  const assignments = new AssignmentCycle(deps, opts, unitIndex, runner, mutex);
  const chains = new ChainPoller(deps, opts, unitIndex, runner, mutex);
  let running = false;
  const timers = new Set<NodeJS.Timeout>();
  const active = new Set<Promise<void>>();
  const now = (): string => new Date((opts.now ?? Date.now)()).toISOString();

  const loop = (run: () => Promise<void>, delay: () => number, source: string): void => {
    if (!running) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!running) return;
      const work = run().catch((error) => deps.logger.error('poll_failed', { timestamp: now(), source, ...describeError(error) }))
        .finally(() => { active.delete(work); loop(run, delay, source); });
      active.add(work);
    }, Math.max(0, delay()));
    timers.add(timer);
  };

  return {
    async start(): Promise<void> {
      if (running) return;
      const states = await deps.routeStates.list();
      for (const state of states) if (state.fsmState !== 'COMPLETED') unitIndex.set(state.unitId, state.assignmentId);
      deps.scheduler.onTask(async (task) => mutex.run(task.assignmentId, () => runner.onTask(task)));
      running = true;
      for (const state of states) {
        try { await mutex.run(state.assignmentId, () => runner.resume(state)); }
        catch (error) { deps.logger.error('route_resume_failed', {
          timestamp: now(), deviceId: state.deviceId, routeId: state.assignmentId, ...describeError(error) }); }
      }
      await assignments.run().catch((error) => deps.logger.error('poll_failed', {
        timestamp: now(), source: 'assignments', ...describeError(error) }));
      loop(() => assignments.run(), () => assignments.nextDelay(), 'assignments');
      const initialChains = chains.run().catch((error) => deps.logger.error('poll_failed', {
        timestamp: now(), source: 'chains', ...describeError(error) }))
        .finally(() => { active.delete(initialChains); loop(() => chains.run(), () => chains.nextDelay(), 'chains'); });
      active.add(initialChains);
    },
    async stop(): Promise<void> {
      if (!running) return;
      running = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      const pendingStarts = assignments.stop();
      await deps.chainQueryLimiter.close();
      await pendingStarts;
      await Promise.all([...active]);
      await deps.scheduler.close();
    },
  };
}
