export const assignment = {
  int_id: '1410255', int_idempresa: '364', int_idunidad: '224979', int_idruta: '1410255',
  int_estado: '1', bol_enuso: true, dt_hora_inicial: new Date('2026-11-17T12:00:00Z'),
  dt_hora_final: new Date('2026-11-17T13:00:00Z'), dt_modificacion: '2026-11-17 11:59:00.123456',
};
export const frame = (id: number, timestamp: string, raw: Buffer) =>
  ({ int_id: id, dt_trama: timestamp, bytea_mensaje: raw });
