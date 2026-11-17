import { UnitValidationError } from './errors';
import { modelFor } from './modelMap';
import type { DeviceDirectory, SqlClient, UnitDevice } from './types';

export const UNIT_SQL = 'SELECT int_id, int_idempresa, int_iddispositivo, bol_enuso FROM catalogos.tbl_unidad WHERE int_id = $1';
export const DEVICE_SQL = 'SELECT int_id, int_idmodelo_dispositivo, bol_enuso FROM catalogos.tbl_dispositivo WHERE int_id = $1';

export class PgDeviceDirectory implements DeviceDirectory {
  constructor(private readonly sql: SqlClient) {}

  async resolveForRouteStart(unitId: number, expectedCompanyId: number): Promise<UnitDevice> {
    const unit = (await this.sql.query(UNIT_SQL, [unitId])).rows[0];
    const deviceId = unit ? Number(unit.int_iddispositivo) : null;
    if (!unit || unit.bol_enuso !== true || Number(unit.int_idempresa) !== expectedCompanyId || deviceId === null || !Number.isSafeInteger(deviceId)) {
      throw new UnitValidationError(unitId, deviceId, `unidad inexistente, fuera de uso o de empresa distinta a ${expectedCompanyId}`);
    }
    const device = (await this.sql.query(DEVICE_SQL, [deviceId])).rows[0];
    if (!device || device.bol_enuso !== true) {
      throw new UnitValidationError(unitId, deviceId, 'dispositivo inexistente o fuera de uso');
    }
    const modelId = Number(device.int_idmodelo_dispositivo);
    return { unitId, companyId: expectedCompanyId, deviceId, modelId, model: modelFor(modelId, deviceId) };
  }
}
