import type { Pool } from 'pg';
import type { RouteAssignment, RouteDetector } from './types';

interface RouteRow {
  imei: string;
  latitud: string;
  longitud: string;
  radio: number;
  orden: number;
}

const ACTIVE_ROUTES_QUERY =
  "SELECT imei, latitud, longitud, radio, orden FROM asignaciones_rutas WHERE estatus = 'vigente'";

export class PgRouteDetector implements RouteDetector {
  constructor(private readonly pool: Pool) {}

  async getActiveRoutes(): Promise<RouteAssignment[]> {
    const result = await this.pool.query<RouteRow>(ACTIVE_ROUTES_QUERY);
    return result.rows.map((row) => ({
      imei: row.imei,
      latitude: Number(row.latitud),
      longitude: Number(row.longitud),
      radius: row.radio,
      order: row.orden,
    }));
  }
}
