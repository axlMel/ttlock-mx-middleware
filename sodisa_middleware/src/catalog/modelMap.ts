import type { ModelName } from '../protocol';
import { UnknownModelError } from './errors';

const MODELS: Record<number, ModelName> = { 25: 'GV300W', 100: 'GV310LAU' };

export function modelFor(modelId: number, deviceId: number): ModelName {
  const model = MODELS[modelId];
  if (!model) throw new UnknownModelError(modelId, deviceId);
  return model;
}
