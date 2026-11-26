import type { DeviceProfile } from './types';
import { validateSerial } from './buildGeoCommand';

export function buildOutOffCommand(profile: DeviceProfile, serial: string): string {
  validateSerial(serial);
  return `AT+GTOUT=${profile.token},,,,,,,0,,,,,,,,,,${serial}$`;
}
