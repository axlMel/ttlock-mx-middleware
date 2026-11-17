export class AuditUnavailableError extends Error {
  constructor() {
    super('No se pudo registrar el intento de comando en la auditoría.');
    this.name = 'AuditUnavailableError';
  }
}
