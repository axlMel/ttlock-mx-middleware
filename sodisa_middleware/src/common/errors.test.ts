import { describeError } from './index';

test('redacta credenciales de URL antes de truncar el mensaje a 200 caracteres', () => {
  const error = Object.assign(new Error(`postgres://u:<valor>@host/db ${'x'.repeat(250)}`), { code: '28P01' });
  const result = describeError(error);
  expect(result).toMatchObject({ errorName: 'Error', errorCode: '28P01' });
  expect(result.errorMessage).toContain('postgres://***@host/db');
  expect(result.errorMessage).not.toContain('<valor>');
  expect(result.errorMessage).toHaveLength(200);
});

test('describe un valor no Error y convierte un código numérico a texto', () => {
  expect(describeError({ code: 503, message: 'redis://:<valor>@host/0' })).toEqual({
    errorName: 'object', errorCode: '503', errorMessage: 'redis://***@host/0',
  });
  expect(describeError('fallo')).toEqual({ errorName: 'string', errorMessage: 'fallo' });
});
