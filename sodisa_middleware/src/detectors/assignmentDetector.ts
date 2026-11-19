import type { SqlClient } from '../db/types';
import type { AssignmentDetector, AssignmentRow, DetectorOptions } from './types';

const COLUMNS = `int_id, int_idempresa, int_idunidad, int_idruta, int_estado, bol_enuso,
       dt_hora_inicial AT TIME ZONE $2 AS dt_hora_inicial,
       dt_hora_final AT TIME ZONE $2 AS dt_hora_final,
       dt_modificacion::text AS dt_modificacion`;
export const VIGENT_STATES: readonly [3, 4] = [3, 4];
export const isActiveAssignment = (row: AssignmentRow): boolean =>
  row.enUso && VIGENT_STATES.includes(row.estado as 3 | 4);

export const ASSIGNMENTS_SQL = `SELECT ${COLUMNS} FROM catalogos.tbl_asignacion_viaje WHERE int_idempresa = $1 AND int_estado IN (3, 4) AND bol_enuso`;
export const ASSIGNMENT_SQL = `SELECT ${COLUMNS} FROM catalogos.tbl_asignacion_viaje WHERE int_id = $1`;

function integer(value: unknown, id: unknown): number {
  const number = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isSafeInteger(number)) {
    throw new Error(`Asignación ${String(id)}: identificador o estado inválido (${String(value)}).`);
  }
  return number;
}

function mapRow(row: Record<string, unknown>): AssignmentRow {
  const id = row.int_id;
  return {
    assignmentId: integer(id, id), companyId: integer(row.int_idempresa, id),
    unitId: integer(row.int_idunidad, id), catalogRouteId: integer(row.int_idruta, id),
    estado: integer(row.int_estado, id), enUso: row.bol_enuso === true,
    horaInicial: row.dt_hora_inicial as Date, horaFinal: row.dt_hora_final as Date,
    modificadoEn: row.dt_modificacion === null ? null : String(row.dt_modificacion),
  };
}

export function createAssignmentDetector(db: SqlClient, opts: Pick<DetectorOptions, 'assignmentTz'>): AssignmentDetector {
  return {
    async listVigentes(companyId) {
      const result = await db.query(ASSIGNMENTS_SQL, [companyId, opts.assignmentTz]);
      return result.rows.map(mapRow);
    },
    async getById(assignmentId) {
      const result = await db.query(ASSIGNMENT_SQL, [assignmentId, opts.assignmentTz]);
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },
  };
}
