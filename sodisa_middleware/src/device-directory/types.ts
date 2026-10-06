export type DeviceModel = 'GV300W' | 'GV310LAU';

export interface DeviceDirectoryEntry {
  imei: string;
  model: DeviceModel;
  ip: string;
  port: number;
}

export interface DeviceDirectory {
  getDeviceInfo(imei: string): Promise<DeviceDirectoryEntry>;
}
