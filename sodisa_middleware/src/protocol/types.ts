export interface DeviceProfile {
  readonly commandDeviceName: 'gv300w' | 'gv310lau';
  readonly zoneReportNames: {
    readonly enter: string;
    readonly exit: string;
  };
  readonly commandTail: string;
}

export interface GeoParams {
  readonly lat: number;
  readonly lon: number;
  readonly radius: number;
  readonly mode: 0 | 3;
}

export type ParsedMessage =
  | { kind: 'ack'; imei: string; raw: string }
  | {
      kind: 'zoneEvent';
      imei: string;
      geofenceId: string;
      event: 'enter' | 'exit';
      raw: string;
    }
  | { kind: 'unknown'; raw: string };
