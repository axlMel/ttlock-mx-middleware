import { createSocket, type Socket } from 'node:dgram';
import { buildGeoCommand } from './command';
import { parseMessage } from './parser';
import { GV300W_PROFILE, GV310LAU_PROFILE } from './profiles';
import { sendGeoCommand } from './transport';

jest.mock('node:dgram', () => ({ createSocket: jest.fn() }));

// Tramas capturadas en campo y documentadas literalmente en spec.md.
const GV300W_ACK = '+ACK:GTGEO,270D04,863457050476769,,0,FFFF,20260921220939,03C8';
const GV300W_ENTER = '+RESP:GTGEO,270D04,863457050476769,,,01,1,1,0.0,0,2257.0,-99.127905,19.355447,20260921220959,0334,0020,0336,8F3D,00,0.2,20260921220959,03C9';
const GV300W_EXIT = '+RESP:GTGEO,270D04,863457050476769,,,00,1,1,3.3,79,2258.0,-99.127571,19.355516,20260921221159,0334,0020,2C1A,90489A1,00,0.2,20260921221159,03CD';
const GV310LAU_ACK = '+ACK:GTGEO,6E0A03,868589060960328,,0,FFFF,20260925001304,01CA';
const GV310LAU_ENTER = '+RESP:GTGIN,6E0A03,868589060960328,,,0,1,00000001,,,,,1,1,0.0,0,2248.0,-99.128239,19.355355,20260925002252,0334,0020,024A,015FAD2B,00,0.0,20260925002253,01F9';
const GV310LAU_EXIT = '+RESP:GTGOT,6E0A03,868589060960328,,,0,1,00000001,,,,,1,1,0.0,0,2249.8,-99.128245,19.355360,20260925002356,0334,0020,024A,015FAD2B,00,0.0,20260925002357,0206';

describe('buildGeoCommand', () => {
  const geoParams = { lat: 19.355383, lon: -99.128206, radius: 50, mode: 3 } as const;

  test('arma el comando GV300W documentado', () => {
    expect(buildGeoCommand(GV300W_PROFILE, geoParams)).toBe(
      'AT+GTGEO=gv300w,0,3,-99.128206,19.355383,50,30,0,0,0,0,0,0,,,0,FFFF$',
    );
  });

  test('arma el comando GV310LAU con Output Status explícito', () => {
    expect(buildGeoCommand(GV310LAU_PROFILE, geoParams)).toBe(
      'AT+GTGEO=gv310lau,0,3,-99.128206,19.355383,50,30,0,0,0,0,0,0,0000,0000,0,FFFF$',
    );
  });

  test('desactiva GV300W con coordenadas y radio válidos', () => {
    expect(buildGeoCommand(GV300W_PROFILE, { ...geoParams, mode: 0 })).toBe(
      'AT+GTGEO=gv300w,0,0,0.000000,0.000000,50,30,0,0,0,0,0,0,,,0,FFFF$',
    );
  });

  test('desactiva GV310LAU con coordenadas y radio válidos', () => {
    expect(buildGeoCommand(GV310LAU_PROFILE, { ...geoParams, mode: 0 })).toBe(
      'AT+GTGEO=gv310lau,0,0,0.000000,0.000000,50,30,0,0,0,0,0,0,0000,0000,0,FFFF$',
    );
  });
});

describe('parseMessage', () => {
  test('clasifica el ACK GV300W', () => {
    expect(parseMessage(GV300W_PROFILE, GV300W_ACK)).toEqual({
      kind: 'ack', imei: '863457050476769', raw: GV300W_ACK,
    });
  });

  test('clasifica la entrada GV300W', () => {
    expect(parseMessage(GV300W_PROFILE, GV300W_ENTER)).toEqual({
      kind: 'zoneEvent', imei: '863457050476769', geofenceId: '0', event: 'enter', raw: GV300W_ENTER,
    });
  });

  test('clasifica la salida GV300W', () => {
    expect(parseMessage(GV300W_PROFILE, GV300W_EXIT)).toEqual({
      kind: 'zoneEvent', imei: '863457050476769', geofenceId: '0', event: 'exit', raw: GV300W_EXIT,
    });
  });

  test('clasifica el ACK GV310LAU', () => {
    expect(parseMessage(GV310LAU_PROFILE, GV310LAU_ACK)).toEqual({
      kind: 'ack', imei: '868589060960328', raw: GV310LAU_ACK,
    });
  });

  test('clasifica la entrada GV310LAU', () => {
    expect(parseMessage(GV310LAU_PROFILE, GV310LAU_ENTER)).toEqual({
      kind: 'zoneEvent', imei: '868589060960328', geofenceId: '0', event: 'enter', raw: GV310LAU_ENTER,
    });
  });

  test('clasifica la salida GV310LAU', () => {
    expect(parseMessage(GV310LAU_PROFILE, GV310LAU_EXIT)).toEqual({
      kind: 'zoneEvent', imei: '868589060960328', geofenceId: '0', event: 'exit', raw: GV310LAU_EXIT,
    });
  });

  test('devuelve unknown ante una cadena malformada', () => {
    const raw = '+RESP:GTGEO,270D04,,,,,01';
    expect(parseMessage(GV300W_PROFILE, raw)).toEqual({ kind: 'unknown', raw });
  });

  test('selecciona la familia de reportes desde el perfil', () => {
    expect(parseMessage(GV300W_PROFILE, GV310LAU_ENTER)).toEqual({
      kind: 'unknown', raw: GV310LAU_ENTER,
    });
  });
});

describe('sendGeoCommand', () => {
  test('envía por UDP al host y puerto recibidos y cierra el socket', async () => {
    const socket = { send: jest.fn(), close: jest.fn() };
    socket.send.mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null) => void;
      callback(null);
    });
    jest.mocked(createSocket).mockReturnValue(socket as unknown as Socket);

    const command = 'AT+GTGEO=gv300w,0,0,0.000000,0.000000,50,30,0,0,0,0,0,0,,,0,FFFF$';
    await sendGeoCommand('10.18.0.1', 55010, command);

    expect(createSocket).toHaveBeenCalledWith('udp4');
    expect(socket.send).toHaveBeenCalledWith(command, 55010, '10.18.0.1', expect.any(Function));
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});
