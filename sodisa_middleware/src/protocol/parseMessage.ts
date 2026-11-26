import type { ParsedMessage } from './types';

const IDX_HEADER = 0;
const IDX_IMEI = 2;
const IDX_ZONE_OR_SERIAL = 5;
const IDX_OUT_SERIAL = 4;
const ACK_FIELD_COUNT = 8;
const GV300W_FIELD_COUNT = 22;
const GV310LAU_FIELD_COUNT = 28;

export function parseMessage(text: string): ParsedMessage {
  const unknown: ParsedMessage = { kind: 'unknown', raw: text };
  const fields = text.replace(/\$$/u, '').split(',');
  const imei = fields[IDX_IMEI];
  if (!/^\d{15}$/.test(imei ?? '')) return unknown;

  const header = fields[IDX_HEADER];
  if (header === '+ACK:GTGEO' || header === '+ACK:GTOUT') {
    const command = header === '+ACK:GTGEO' ? 'GTGEO' : 'GTOUT';
    const serial = fields[command === 'GTGEO' ? IDX_ZONE_OR_SERIAL : IDX_OUT_SERIAL];
    const minimumFields = command === 'GTGEO' ? ACK_FIELD_COUNT : 7;
    return fields.length >= minimumFields && /^[0-9A-F]{4}$/.test(serial ?? '')
      ? { kind: 'ack', command, imei, serial, raw: text } : unknown;
  }

  if (header === '+RESP:GTGEO') {
    const code = fields[IDX_ZONE_OR_SERIAL];
    if (fields.length < GV300W_FIELD_COUNT || !/^[0-9A-F][01]$/.test(code ?? '')) return unknown;
    return {
      kind: 'zoneEvent', imei, geofenceId: parseInt(code![0], 16),
      event: code![1] === '1' ? 'enter' : 'exit', raw: text,
    };
  }

  if (header === '+RESP:GTGIN' || header === '+RESP:GTGOT') {
    const zone = fields[IDX_ZONE_OR_SERIAL];
    if (fields.length < GV310LAU_FIELD_COUNT || !/^(?:[0-9]|1[0-9])$/.test(zone ?? '')) return unknown;
    return { kind: 'zoneEvent', imei, geofenceId: Number(zone), event: header === '+RESP:GTGIN' ? 'enter' : 'exit', raw: text };
  }
  return unknown;
}
