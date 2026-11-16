import {
  PgDeviceDirectory,
  UnknownDeviceError,
  UnsupportedDeviceModelError,
} from './deviceDirectory';

// La suite consulta únicamente la BD local sembrada por docker-compose.yml.
const LOCAL_DATABASE_URL = 'postgresql://gtlock_dev:gtlock_dev@127.0.0.1:5433/atagps_local';

describe('PgDeviceDirectory con la BD local', () => {
  let directory: PgDeviceDirectory;

  beforeAll(() => {
    directory = new PgDeviceDirectory(LOCAL_DATABASE_URL);
  });

  afterAll(async () => {
    await directory.close();
  });

  test('resuelve el GV300W con su IP y puerto de origen', async () => {
    await expect(directory.getDeviceInfo('863457050476769')).resolves.toEqual({
      imei: '863457050476769',
      model: 'GV300W',
      ip: '10.50.0.11',
      port: 55010,
    });
  });

  test('resuelve el GV310LAU con su IP y puerto de origen', async () => {
    await expect(directory.getDeviceInfo('868589060960328')).resolves.toEqual({
      imei: '868589060960328',
      model: 'GV310LAU',
      ip: '10.50.0.12',
      port: 55077,
    });
  });

  test('rechaza un IMEI inexistente', async () => {
    await expect(directory.getDeviceInfo('999999999999999')).rejects.toBeInstanceOf(UnknownDeviceError);
  });

  test('rechaza un modelo sin perfil conocido', async () => {
    await expect(directory.getDeviceInfo('000000000000000')).rejects.toBeInstanceOf(
      UnsupportedDeviceModelError,
    );
  });

  test('trata el IMEI como parámetro SQL, no como fragmento de consulta', async () => {
    await expect(directory.getDeviceInfo("' OR 1=1 --")).rejects.toBeInstanceOf(UnknownDeviceError);
  });
});
