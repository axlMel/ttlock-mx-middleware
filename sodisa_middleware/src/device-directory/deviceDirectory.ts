import { Pool } from 'pg';
import type { DeviceProfile } from '../protocol/types';
import type { DeviceDirectory, DeviceDirectoryEntry, DeviceModel } from './types';

interface DeviceRow {
  imei: string;
  modelo: string;
  ip: string;
  puerto: number;
}

const PROFILE_BY_MODEL = new Map<DeviceModel, DeviceProfile['commandDeviceName']>([
  ['GV300W', 'gv300w'],
  ['GV310LAU', 'gv310lau'],
]);

const DEVICE_QUERY = 'SELECT imei, modelo, ip, puerto FROM resumen_unidad WHERE imei = $1';

export class UnknownDeviceError extends Error {
  constructor(imei: string) {
    super(`No se encontró el dispositivo con IMEI ${imei}.`);
    this.name = 'UnknownDeviceError';
  }
}

export class UnsupportedDeviceModelError extends Error {
  constructor(imei: string, model: string) {
    super(`El modelo ${model} del dispositivo ${imei} no tiene un perfil compatible.`);
    this.name = 'UnsupportedDeviceModelError';
  }
}

export class PgDeviceDirectory implements DeviceDirectory {
  private readonly pool: Pool;

  constructor(databaseUrl: string | undefined = process.env.DATABASE_URL) {
    if (!databaseUrl) {
      throw new Error('Falta configurar DATABASE_URL para el directorio de dispositivos.');
    }
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async getDeviceInfo(imei: string): Promise<DeviceDirectoryEntry> {
    const result = await this.pool.query<DeviceRow>(DEVICE_QUERY, [imei]);
    const row = result.rows[0];
    if (!row) {
      throw new UnknownDeviceError(imei);
    }

    const profileName = PROFILE_BY_MODEL.get(row.modelo as DeviceModel);
    if (!profileName) {
      throw new UnsupportedDeviceModelError(row.imei, row.modelo);
    }

    return {
      imei: row.imei,
      model: row.modelo as DeviceModel,
      ip: row.ip,
      port: row.puerto,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
