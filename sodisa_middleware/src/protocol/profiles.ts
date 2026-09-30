import type { DeviceProfile } from './types';

export const GV300W_PROFILE: DeviceProfile = {
  commandDeviceName: 'gv300w',
  zoneReportNames: { enter: 'GTGEO', exit: 'GTGEO' },
  commandTail: '30,0,0,0,0,0,0,,,0,FFFF$',
};

export const GV310LAU_PROFILE: DeviceProfile = {
  commandDeviceName: 'gv310lau',
  zoneReportNames: { enter: 'GTGIN', exit: 'GTGOT' },
  commandTail: '30,0,0,0,0,0,0,0000,0000,0,FFFF$',
};
