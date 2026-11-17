import type { DeviceProfile, ModelName } from './types';

export const PROFILES: Record<ModelName, DeviceProfile> = {
  GV300W: { model: 'GV300W', token: 'gv300w', tailFields: ',,' },
  GV310LAU: { model: 'GV310LAU', token: 'gv310lau', tailFields: '0000,0000' },
};

export function profileFor(model: ModelName): DeviceProfile {
  return PROFILES[model];
}
