export type ModelName = 'GV300W' | 'GV310LAU';

export interface DeviceProfile {
  model: ModelName;
  token: string;
  tailFields: string;
}

export interface GeoCommandInput {
  latitude: number;
  longitude: number;
  radiusM: number;
  mode: 0 | 1 | 2 | 3;
  serial: string;
  zoneId?: number;
  checkIntervalS?: number;
}

export type ParsedMessage =
  | { kind: 'ack'; command: 'GTGEO' | 'GTOUT'; imei: string; serial: string; raw: string }
  | { kind: 'zoneEvent'; imei: string; geofenceId: number; event: 'enter' | 'exit'; raw: string }
  | { kind: 'unknown'; raw: string };
