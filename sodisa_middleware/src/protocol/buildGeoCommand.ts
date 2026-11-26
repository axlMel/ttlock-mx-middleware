import { InvalidCommandInputError } from './errors';
import type { DeviceProfile, GeoCommandInput } from './types';

export const RESET_PARAMS = { latitude: 0, longitude: 0, radiusM: 50, mode: 0 } as const;

export function validateSerial(serial: string): void {
  if (typeof serial !== 'string' || !/^[0-9A-F]{4}$/.test(serial)) throw new InvalidCommandInputError('serial', serial);
}

function validate(input: GeoCommandInput): void {
  const { latitude, longitude, radiusM, mode, serial, zoneId = 0, checkIntervalS = 30 } = input;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new InvalidCommandInputError('latitude', latitude);
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new InvalidCommandInputError('longitude', longitude);
  if (!Number.isInteger(radiusM) || radiusM < 50 || radiusM > 6_000_000) throw new InvalidCommandInputError('radiusM', radiusM);
  if (![0, 1, 2, 3].includes(mode)) throw new InvalidCommandInputError('mode', mode);
  validateSerial(serial);
  if (!Number.isInteger(zoneId) || zoneId < 0 || zoneId > 19) throw new InvalidCommandInputError('zoneId', zoneId);
  if (!Number.isInteger(checkIntervalS) || checkIntervalS < 0) throw new InvalidCommandInputError('checkIntervalS', checkIntervalS);
}

export function buildGeoCommand(profile: DeviceProfile, input: GeoCommandInput): string {
  validate(input);
  const { zoneId = 0, checkIntervalS = 30 } = input;
  const prefix = `AT+GTGEO=${profile.token},${zoneId},${input.mode},${input.longitude.toFixed(6)},${input.latitude.toFixed(6)},${input.radiusM},${checkIntervalS},0,0,0,0,0,0`;
  const tail = profile.tailFields.startsWith(',') ? profile.tailFields : `,${profile.tailFields}`;
  return `${prefix}${tail},0,${input.serial}$`;
}

export function buildResetCommand(profile: DeviceProfile, serial: string, zoneId = 0): string {
  return buildGeoCommand(profile, { ...RESET_PARAMS, serial, zoneId });
}
