import type { DeviceProfile, ParsedMessage } from './types';

export function parseMessage(profile: DeviceProfile, raw: string): ParsedMessage {
  const separator = raw.indexOf(',');
  if (separator < 0) {
    return { kind: 'unknown', raw };
  }

  const header = raw.slice(0, separator);
  const fields = raw.slice(separator + 1).split(',');
  const imei = fields[1];
  if (!imei) {
    return { kind: 'unknown', raw };
  }

  if (header === '+ACK:GTGEO') {
    return { kind: 'ack', imei, raw };
  }

  const zoneCode = fields[4];
  if (!zoneCode) {
    return { kind: 'unknown', raw };
  }

  const { enter, exit } = profile.zoneReportNames;
  if (enter === exit) {
    if (header !== `+RESP:${enter}` || !/^[0-9A-Fa-f][01]$/.test(zoneCode)) {
      return { kind: 'unknown', raw };
    }

    return {
      kind: 'zoneEvent',
      imei,
      geofenceId: zoneCode[0],
      event: zoneCode[1] === '1' ? 'enter' : 'exit',
      raw,
    };
  }

  if ((header !== `+RESP:${enter}` && header !== `+RESP:${exit}`) || !/^[0-9A-Fa-f]+$/.test(zoneCode)) {
    return { kind: 'unknown', raw };
  }

  return {
    kind: 'zoneEvent',
    imei,
    geofenceId: zoneCode,
    event: header === `+RESP:${enter}` ? 'enter' : 'exit',
    raw,
  };
}
