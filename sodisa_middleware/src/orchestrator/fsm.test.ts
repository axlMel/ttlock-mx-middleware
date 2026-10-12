import type { RouteState } from '../persistence/types';
import { transition } from './fsm';
import type { DomainEvent } from './types';

const base: RouteState = {
  deviceId: '863457050476769',
  routeId: '863457050476769',
  currentSiteIndex: 0,
  fsmState: 'PENDING',
  lastCommandSentAt: null,
  retryCount: 0,
};
const at = (fsmState: RouteState['fsmState'], index = 0): RouteState =>
  ({ ...base, fsmState, currentSiteIndex: index });

describe('transition', () => {
  const rows: Array<[string, RouteState | null, DomainEvent, RouteState | null]> = [
    ['1: crea estado al detectar asignación', null,
      { type: 'ASSIGNMENT_DETECTED', deviceId: base.deviceId, routeId: base.routeId }, base],
    ['2: prepara el paso', at('PENDING'), { type: 'STEP_READY' }, at('CONFIGURING')],
    ['3: espera ACK tras enviar', at('CONFIGURING'),
      { type: 'COMMAND_SENT', sentAt: '2026-10-12T12:00:00.000Z' },
      { ...at('AWAITING_ACK'), lastCommandSentAt: '2026-10-12T12:00:00.000Z' }],
    ['4: ACK del sitio activa geocerca', at('AWAITING_ACK'),
      { type: 'ACK', siteCount: 2 }, at('IN_ZONE')],
    ['5: lote agotado conserva el paso', at('AWAITING_ACK'),
      { type: 'BATCH_EXHAUSTED' }, at('AWAITING_ACK')],
    ['6: entrada registra espera de salida', at('IN_ZONE'),
      { type: 'ZONE_ENTER' }, at('AWAITING_EXIT_ALERT')],
    ['7: salida avanza al siguiente sitio', at('AWAITING_EXIT_ALERT'),
      { type: 'ZONE_EXIT', siteCount: 2 }, { ...at('PENDING', 1), retryCount: 0 }],
    ['8: última salida prepara reset', at('IN_ZONE', 1),
      { type: 'ZONE_EXIT', siteCount: 2 }, at('CONFIGURING', 2)],
    ['9: ACK del reset completa la ruta', at('AWAITING_ACK', 2),
      { type: 'ACK', siteCount: 2 }, at('COMPLETED', 2)],
    ['10: evento ajeno no cambia el estado', at('PENDING'),
      { type: 'ACK', siteCount: 2 }, at('PENDING')],
  ];

  test.each(rows)('%s', (_name, state, event, expected) => {
    expect(transition(state, event)).toEqual(expected);
  });

  test('un reenvío actualiza hora y contador sin cambiar de paso', () => {
    const waiting = { ...at('AWAITING_ACK'), retryCount: 2 };
    expect(transition(waiting, { type: 'COMMAND_RESENT', sentAt: '2026-10-12T12:01:00.000Z' }))
      .toEqual({ ...waiting, lastCommandSentAt: '2026-10-12T12:01:00.000Z', retryCount: 3 });
  });

  test('una salida sin entrada previa se acepta', () => {
    expect(transition(at('IN_ZONE'), { type: 'ZONE_EXIT', siteCount: 2 }))
      .toEqual(at('PENDING', 1));
  });

  test('un ACK duplicado o una entrada repetida devuelve el mismo objeto', () => {
    const inZone = at('IN_ZONE');
    expect(transition(inZone, { type: 'ACK', siteCount: 2 })).toBe(inZone);
    const awaitingExit = at('AWAITING_EXIT_ALERT');
    expect(transition(awaitingExit, { type: 'ZONE_ENTER' })).toBe(awaitingExit);
  });
});
