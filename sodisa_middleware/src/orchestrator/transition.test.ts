import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteState } from '../persistence';
import { parseMessage } from '../protocol';
import { serialFor } from './serial';
import { transition } from './transition';
import { FakeScheduler } from './scheduler';
import { KeyedMutex } from './keyedMutex';

const base: RouteState = {
  assignmentId: 42, companyId: 364, apiCompanyId: 2, unitId: 81, deviceId: 9001,
  model: 'GV300W', catalogRouteId: 17, routeType: 0, fsmState: 'CONFIGURING',
  currentPointId: 3, completedPointIds: [], stepSeq: 0, transmissionSeq: 1, retryCount: 0,
  pendingRequest: { idempotencyKey: '42-0-1', body: { companyId: 2, unitId: '81', comando: 'AT+GTGEO$' } },
  lastAcceptedCommand: null, firstTransmissionAt: null,
  ackDeadline: null, closing: null, startedAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z',
};

test('serial hexadecimal de cuatro dígitos', () => {
  expect(serialFor(0)).toBe('0000');
  expect(serialFor(255)).toBe('00FF');
  expect(serialFor(65535)).toBe('FFFF');
  expect(() => serialFor(65536)).toThrow();
});

test('la primera transmisión se conserva al retransmitir y se limpia al cambiar de paso', () => {
  const sent = { ...base, firstTransmissionAt: '2026-11-17T00:00:00Z', fsmState: 'AWAITING_ACK' as const,
    pendingRequest: null, ackDeadline: new Date(1000).toISOString() };
  expect(transition(sent, { kind: 'ACK_DEADLINE', at: 1000, backoffMs: 60000, resend: true, dryRun: false })
    .state?.firstTransmissionAt).toBe(sent.firstTransmissionAt);
  const zone = { ...sent, fsmState: 'AWAITING_EXIT_ALERT' as const };
  expect(transition(zone, { kind: 'EXIT', geofenceId: 0, nextPointId: 5 }).state?.firstTransmissionAt).toBeNull();
  expect(transition(zone, { kind: 'ASSIGNMENT_ENDED', finalEstado: 5 }).state?.firstTransmissionAt).toBeNull();
});

test('ACCEPTED programa ventana; dryRun no la programa', () => {
  const normal = transition(base, { kind: 'GATEWAY_ACCEPTED', at: 1000, backoffMs: 60000, dryRun: false, command: 'AT+GTGEO$' });
  expect(normal.state).toMatchObject({ fsmState: 'AWAITING_ACK', pendingRequest: null, ackDeadline: new Date(61000).toISOString() });
  expect(normal.effects).toEqual(['SCHEDULE_ACK']);
  const shadow = transition(base, { kind: 'GATEWAY_ACCEPTED', at: 1000, backoffMs: 60000, dryRun: true, command: 'AT+GTGEO$' });
  expect(shadow.state?.ackDeadline).toBeNull();
  expect(shadow.effects).toEqual([]);
});

test('ACK correcto activa zona; otro serial y eventos repetidos se ignoran', () => {
  expect(transition(base, { kind: 'ACK', command: 'GTGEO', serial: '00FF' }).state).toBe(base);
  const active = transition(base, { kind: 'ACK', command: 'GTGEO', serial: '0000' }).state!;
  expect(active.fsmState).toBe('AWAITING_ENTER_ALERT');
  expect(transition(active, { kind: 'ACK', command: 'GTGEO', serial: '0000' }).state).toBe(active);
  expect(transition(active, { kind: 'ENTER', geofenceId: 1 }).state).toBe(active);
  expect(transition(active, { kind: 'ENTER', geofenceId: 0 }).state?.fsmState).toBe('AWAITING_EXIT_ALERT');
  expect(transition({ ...base, fsmState: 'AWAITING_ACK', pendingRequest: null }, { kind: 'ENTER', geofenceId: 0 }).state?.fsmState).toBe('AWAITING_ACK');
  const entered = transition(active, { kind: 'ENTER', geofenceId: 0 }).state!;
  expect(transition(entered, { kind: 'ENTER', geofenceId: 0 }).state).toBe(entered);
});

test('salida sin entrada se ignora; después de entrar avanza punto o reset', () => {
  const active = { ...base, fsmState: 'AWAITING_ENTER_ALERT' as const, pendingRequest: null };
  expect(transition(active, { kind: 'EXIT', geofenceId: 0, nextPointId: 5 }))
    .toEqual({ state: active, effects: ['EXIT_BEFORE_ENTER_IGNORED'] });
  const entered = transition(active, { kind: 'ENTER', geofenceId: 0 }).state!;
  const next = transition(entered, { kind: 'EXIT', geofenceId: 0, nextPointId: 5 }).state!;
  expect(next).toMatchObject({ fsmState: 'PENDING', currentPointId: 5, completedPointIds: [3], stepSeq: 1 });
  const reset = transition(entered, { kind: 'EXIT', geofenceId: 0, nextPointId: null }).state!;
  expect(reset.closing).toEqual({ reason: 'ROUTE_DONE', finalEstado: null });
  expect(transition(active, { kind: 'EXIT', geofenceId: 1, nextPointId: 5 }).state).toBe(active);
});

test('ACK de reset pasa a GTOUT; solo su ACK del tipo y serial correctos completa', () => {
  const reset = { ...base, currentPointId: null, closingPhase: 'RESET' as const,
    closing: { reason: 'ROUTE_DONE' as const, finalEstado: null } };
  const out = transition(reset, { kind: 'ACK', command: 'GTGEO', serial: '0000' }).state!;
  expect(out).toMatchObject({ fsmState: 'PENDING', closingPhase: 'OUT_OFF', stepSeq: 1 });
  const awaiting = { ...out, fsmState: 'AWAITING_ACK' as const };
  expect(transition(awaiting, { kind: 'ACK', command: 'GTGEO', serial: '0001' }).state).toBe(awaiting);
  expect(transition(awaiting, { kind: 'ACK', command: 'GTOUT', serial: '0000' }).state).toBe(awaiting);
  expect(transition(awaiting, { kind: 'ACK', command: 'GTOUT', serial: '0001' }).state?.fsmState).toBe('COMPLETED');
  expect(transition({ ...awaiting, closing: { reason: 'ASSIGNMENT_ENDED', finalEstado: 4 } },
    { kind: 'ACK', command: 'GTOUT', serial: '0001' }).state).toBeNull();
});

test('ACK GTOUT reales de reglas no cierran un paso con serial 0A05', () => {
  const state: RouteState = { ...base, fsmState: 'AWAITING_ACK', currentPointId: null,
    closingPhase: 'OUT_OFF', closing: { reason: 'ROUTE_DONE', finalEstado: null },
    stepSeq: 0x0A05, pendingRequest: null };
  const eventFromFixture = (name: string) => {
    const raw = readFileSync(join(__dirname, '../protocol/__fixtures__', `${name}.txt`), 'utf8').trimEnd();
    const parsed = parseMessage(raw);
    if (parsed.kind !== 'ack') throw new Error('La trama real no se clasificó como ACK');
    return { kind: 'ACK' as const, command: parsed.command, serial: parsed.serial };
  };
  expect(transition(state, eventFromFixture('gv300w-out-ack-b')).state).toBe(state);
  expect(transition(state, eventFromFixture('gv300w-out-ack-c')).state).toBe(state);
  expect(transition(state, eventFromFixture('gv300w-out-ack-a')).state?.fsmState).toBe('COMPLETED');
  expect(transition({ ...state, model: 'GV310LAU' }, eventFromFixture('gv310lau-out-ack')).state?.fsmState).toBe('COMPLETED');
});

test('cierre sin transmisión elimina; con transmisión crea reset', () => {
  expect(transition({ ...base, fsmState: 'PENDING', transmissionSeq: 0, pendingRequest: null }, { kind: 'ASSIGNMENT_ENDED', finalEstado: 4 }).state).toBeNull();
  expect(transition(base, { kind: 'ASSIGNMENT_ENDED', finalEstado: 4 }).state).toMatchObject({ currentPointId: null, closing: { reason: 'ASSIGNMENT_ENDED', finalEstado: 4 }, stepSeq: 1 });
  expect(transition({ ...base, fsmState: 'COMPLETED' }, { kind: 'ASSIGNMENT_ENDED', finalEstado: 4 }).state).toBeNull();
});

test('si pierde vigencia en OUT_OFF conserva la fase y el serial', () => {
  const out: RouteState = { ...base, fsmState: 'AWAITING_ACK', currentPointId: null,
    closing: { reason: 'ROUTE_DONE', finalEstado: null }, closingPhase: 'OUT_OFF', stepSeq: 2 };
  const next = transition(out, { kind: 'ASSIGNMENT_ENDED', finalEstado: 5 }).state;
  expect(next).toMatchObject({ closing: { reason: 'ASSIGNMENT_ENDED', finalEstado: 5 },
    closingPhase: 'OUT_OFF', stepSeq: 2, fsmState: 'AWAITING_ACK' });
});

test('ventana vencida retransmite o solo espera; dryRun no retransmite', () => {
  const awaiting = { ...base, fsmState: 'AWAITING_ACK' as const, pendingRequest: null, ackDeadline: new Date(1000).toISOString() };
  expect(transition(awaiting, { kind: 'ACK_DEADLINE', at: 1000, backoffMs: 60000, resend: true, dryRun: false }).state).toMatchObject({ fsmState: 'CONFIGURING', transmissionSeq: 2, retryCount: 1 });
  expect(transition(awaiting, { kind: 'ACK_DEADLINE', at: 1000, backoffMs: 60000, resend: false, dryRun: false }).effects).toEqual(['SCHEDULE_ACK']);
  expect(transition(awaiting, { kind: 'ACK_DEADLINE', at: 1000, backoffMs: 60000, resend: true, dryRun: true }).state).toBe(awaiting);
});

test('mutex serializa la misma asignación y permite otra', async () => {
  const mutex = new KeyedMutex();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const first = mutex.run(42, async () => { events.push('first'); await gate; });
  const second = mutex.run(42, async () => { events.push('second'); });
  await mutex.run(43, async () => { events.push('other'); });
  expect(events).toEqual(['first', 'other']);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(['first', 'other', 'second']);
});

test('FakeScheduler deduplica jobId y ejecuta al vencer', async () => {
  const scheduler = new FakeScheduler();
  const calls: string[] = [];
  scheduler.onTask(async (task) => { calls.push(task.kind); });
  const task = { kind: 'ACK_DEADLINE' as const, assignmentId: 42, stepSeq: 0, transmissionSeq: 1 };
  await scheduler.schedule('ack:42:0:1', 100, task);
  await scheduler.schedule('ack:42:0:1', 100, task);
  expect(scheduler.count()).toBe(1);
  await scheduler.advance(100);
  expect(calls).toEqual(['ACK_DEADLINE']);
});
