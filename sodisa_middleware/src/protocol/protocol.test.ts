import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildGeoCommand, buildResetCommand, decodeFrame, InvalidCommandInputError, parseMessage, profileFor, PROFILES, RESET_PARAMS, type GeoCommandInput } from './index';

const fixtures = join(__dirname, '__fixtures__');
const fixture = (name: string): string => readFileSync(join(fixtures, `${name}.txt`), 'utf8').trimEnd();
const input: GeoCommandInput = { latitude: 19.355383, longitude: -99.128206, radiusM: 50, mode: 3, serial: '0001' };

test('perfiles y comandos exactos de ambos modelos', () => {
  expect(profileFor('GV300W')).toBe(PROFILES.GV300W);
  expect(buildGeoCommand(PROFILES.GV300W, input)).toBe('AT+GTGEO=gv300w,0,3,-99.128206,19.355383,50,30,0,0,0,0,0,0,,,0,0001$');
  expect(buildGeoCommand(PROFILES.GV310LAU, input)).toBe('AT+GTGEO=gv310lau,0,3,-99.128206,19.355383,50,30,0,0,0,0,0,0,0000,0000,0,0001$');
  expect(buildGeoCommand(PROFILES.GV300W, { ...input, longitude: -99.1, latitude: 19.3, zoneId: 10, checkIntervalS: 0 })).toContain(',10,3,-99.100000,19.300000,50,0,');
});

test('reset usa RESET_PARAMS para ambos modelos', () => {
  expect(RESET_PARAMS).toEqual({ latitude: 0, longitude: 0, radiusM: 50, mode: 0 });
  expect(buildResetCommand(PROFILES.GV300W, 'FFFF')).toBe('AT+GTGEO=gv300w,0,0,0.000000,0.000000,50,30,0,0,0,0,0,0,,,0,FFFF$');
  expect(buildResetCommand(PROFILES.GV310LAU, '000A', 5)).toBe('AT+GTGEO=gv310lau,5,0,0.000000,0.000000,50,30,0,0,0,0,0,0,0000,0000,0,000A$');
});

test.each([
  ['latitude', NaN], ['latitude', -91], ['latitude', 91], ['longitude', Infinity], ['longitude', -181], ['longitude', 181],
  ['radiusM', 49], ['radiusM', 6_000_001], ['radiusM', 50.5], ['mode', 4], ['serial', 'abcd'], ['serial', 'ABC'],
  ['zoneId', -1], ['zoneId', 20], ['zoneId', 1.5], ['checkIntervalS', -1], ['checkIntervalS', 0.5],
] as const)('rechaza %s=%s', (field, value) => {
  const invalid = { ...input, [field]: value } as GeoCommandInput;
  expect(() => buildGeoCommand(PROFILES.GV300W, invalid)).toThrow(InvalidCommandInputError);
  expect(() => buildGeoCommand(PROFILES.GV300W, invalid)).toThrow(field);
});

test('decodeFrame lee bytea_mensaje como latin1 y recorta el final', () => {
  expect(decodeFrame(Buffer.from('+ACK:GTGEO,\xff \r\n', 'latin1'))).toBe('+ACK:GTGEO,ÿ');
});

test.each([
  ['gv300w-ack', { kind: 'ack', imei: '863457050476769', serial: 'FFFF' }],
  ['gv310lau-ack-a', { kind: 'ack', imei: '135790246811220', serial: '000A' }],
  ['gv310lau-ack-b', { kind: 'ack', imei: '868589060960328', serial: 'FFFF' }],
  ['gv300w-enter', { kind: 'zoneEvent', imei: '863457050476769', geofenceId: 0, event: 'enter' }],
  ['gv300w-exit', { kind: 'zoneEvent', imei: '863457050476769', geofenceId: 0, event: 'exit' }],
  ['gv310lau-enter', { kind: 'zoneEvent', imei: '868589060960328', geofenceId: 0, event: 'enter' }],
  ['gv310lau-exit', { kind: 'zoneEvent', imei: '868589060960328', geofenceId: 0, event: 'exit' }],
] as const)('clasifica fixture %s', (name, expected) => {
  const raw = fixture(name);
  expect(parseMessage(raw)).toEqual({ ...expected, raw });
});

test('GV300W interpreta A1 como entrada en zona 10', () => {
  const raw = fixture('gv300w-enter').replace(',,,01,', ',,,A1,');
  expect(parseMessage(raw)).toMatchObject({ kind: 'zoneEvent', geofenceId: 10, event: 'enter' });
});

test('máscara LAU coincide con el id de zona de ambos fixtures', () => {
  for (const name of ['gv310lau-enter', 'gv310lau-exit']) {
    const raw = fixture(name);
    const fields = raw.split(',');
    const parsed = parseMessage(raw);
    expect(parsed.kind).toBe('zoneEvent');
    if (parsed.kind === 'zoneEvent') expect(parseInt(fields[7], 16) & (1 << parsed.geofenceId)).toBe(1 << parsed.geofenceId);
  }
});

test('tolera terminador opcional', () => {
  const raw = fixture('gv310lau-ack-b');
  expect(parseMessage(raw.slice(0, -1))).toEqual({ ...parseMessage(raw), raw: raw.slice(0, -1) });
});

test.each(['', 'basura', '+ACK:GTGEO,270D04,863457050476769', '+RESP:GTGEO,270D04,863457050476769,,,01', '+RESP:GTGIN,6E0A03,868589060960328,,,x,1'])('trama inválida devuelve unknown', (raw) => {
  expect(parseMessage(raw)).toEqual({ kind: 'unknown', raw });
});

test('el módulo no importa transporte ni usa fetch', () => {
  for (const name of readdirSync(__dirname).filter((file) => file.endsWith('.ts'))) {
    const source = readFileSync(join(__dirname, name), 'utf8');
    if (name === 'protocol.test.ts') continue;
    expect(source).not.toMatch(/(?:from\s*['"](?:node:)?(?:dgram|net|http|https)['"]|\bfetch\s*\()/);
  }
});
