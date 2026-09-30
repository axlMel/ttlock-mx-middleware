import type { DeviceProfile, GeoParams } from './types';

export function buildGeoCommand(profile: DeviceProfile, params: GeoParams): string {
  // Mode=0 desactiva la geocerca; el radio debe conservar el mínimo válido.
  const lon = params.mode === 0 ? '0.000000' : String(params.lon);
  const lat = params.mode === 0 ? '0.000000' : String(params.lat);
  const radius = params.mode === 0 ? 50 : params.radius;

  return `AT+GTGEO=${profile.commandDeviceName},0,${params.mode},${lon},${lat},${radius},${profile.commandTail}`;
}
