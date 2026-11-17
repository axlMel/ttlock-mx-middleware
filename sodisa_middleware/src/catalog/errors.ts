export class UnknownModelError extends Error {
  constructor(modelId: number, deviceId: number) {
    super(`Modelo ${modelId} desconocido para el dispositivo ${deviceId}.`);
    this.name = 'UnknownModelError';
  }
}

export class UnitValidationError extends Error {
  constructor(unitId: number, deviceId: number | null, detail: string) {
    super(`Unidad ${unitId}, dispositivo ${deviceId ?? 'desconocido'}: ${detail}.`);
    this.name = 'UnitValidationError';
  }
}

export class InvalidPlanError extends Error {
  constructor(routeId: number, detail: string) {
    super(`Ruta ${routeId}: ${detail}.`);
    this.name = 'InvalidPlanError';
  }
}
