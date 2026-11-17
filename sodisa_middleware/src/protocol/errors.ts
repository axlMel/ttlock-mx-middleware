export class InvalidCommandInputError extends Error {
  constructor(field: string, value: unknown) {
    super(`Valor inválido para ${field}: ${String(value)}`);
    this.name = 'InvalidCommandInputError';
  }
}
