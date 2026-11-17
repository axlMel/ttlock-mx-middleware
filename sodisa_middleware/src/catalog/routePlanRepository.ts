import type { CatalogCacheStore } from '../persistence/catalogCacheStore';
import type { CatalogEntry } from '../persistence/types';
import { InvalidPlanError } from './errors';
import type { RoutePlan, RoutePlanPoint, RoutePlanRepository, SqlClient } from './types';

export const ROUTE_SQL = 'SELECT int_id, int_idempresa, int_tipo, dt_modificacion FROM catalogos.tbl_ruta WHERE int_id = $1';
export const POINTS_SQL = 'SELECT int_id, int_idempresa, int_idruta, int_orden, bol_enuso, int_idsitio, dt_modificacion FROM catalogos.tbl_punto_ruta WHERE int_idempresa = $1 AND int_idruta = $2';
export const SITE_SQL = 'SELECT int_id, bol_enuso, int_radio, dt_modificacion, ST_Y(g_posicion::geometry) AS latitud, ST_X(g_posicion::geometry) AS longitud FROM catalogos_gis.tbl_sitio WHERE int_id = $1';

type Row = Record<string, unknown>;
export interface RoutePlanOptions {
  revalidateMs?: number;
  now?: () => Date;
  onNotice?: (message: string) => void;
}

export class PgRoutePlanRepository implements RoutePlanRepository {
  constructor(private readonly sql: SqlClient, private readonly cache: CatalogCacheStore, private readonly options: RoutePlanOptions = {}) {}

  async getPlan(companyId: number, catalogRouteId: number, opts: { forceFresh?: boolean } = {}): Promise<RoutePlan> {
    const fresh = opts.forceFresh === true;
    const route = await this.read<Row | null>('route', catalogRouteId, () => this.first(ROUTE_SQL, [catalogRouteId]), fresh);
    const routeType = route?.int_tipo;
    if (!route || Number(route.int_idempresa) !== companyId ||
      (routeType !== 0 && routeType !== 1 && routeType !== '0' && routeType !== '1')) {
      throw new InvalidPlanError(catalogRouteId, `ruta inexistente, tipo inválido o empresa distinta a ${companyId}`);
    }
    if (Number(route.int_tipo) === 1) return { routeType: 1, points: [] };

    const rows = await this.read<Row[]>('route-points', catalogRouteId,
      async () => (await this.sql.query(POINTS_SQL, [companyId, catalogRouteId])).rows, fresh);
    const active = rows.filter((row) => row.bol_enuso === true).sort((a, b) =>
      Number(a.int_orden) - Number(b.int_orden) || Number(a.int_id) - Number(b.int_id));
    if (active.length === 0) throw new InvalidPlanError(catalogRouteId, 'plan sin puntos activos');

    const points: RoutePlanPoint[] = [];
    for (const row of active) {
      const pointId = Number(row.int_id);
      const siteId = Number(row.int_idsitio);
      const site = await this.read<Row | null>('site', siteId, () => this.first(SITE_SQL, [siteId]), fresh);
      if (!site || site.bol_enuso !== true) throw new InvalidPlanError(catalogRouteId, `sitio ${siteId} faltante o fuera de uso para punto ${pointId}`);
      const radius = this.numeric(site.int_radio, 'radio', catalogRouteId, pointId, siteId);
      if (radius > 6_000_000) throw new InvalidPlanError(catalogRouteId, `radio inválido en punto ${pointId}, sitio ${siteId}`);
      const latitude = this.numeric(site.latitud, 'latitud', catalogRouteId, pointId, siteId);
      const longitude = this.numeric(site.longitud, 'longitud', catalogRouteId, pointId, siteId);
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        throw new InvalidPlanError(catalogRouteId, `coordenadas inválidas en punto ${pointId}, sitio ${siteId}`);
      }
      if (radius < 50) this.options.onNotice?.(`Radio ajustado a 50 en ruta ${catalogRouteId}, punto ${pointId}, sitio ${siteId}`);
      points.push({ pointId, order: Number(row.int_orden), siteId, latitude, longitude,
        radiusM: Math.max(50, radius), radiusAdjusted: radius < 50 });
    }
    return { routeType: 0, points };
  }

  private numeric(value: unknown, name: string, routeId: number, pointId: number, siteId: number): number {
    if (value === null || value === undefined || typeof value === 'boolean' || value === '') {
      throw new InvalidPlanError(routeId, `${name} inválido en punto ${pointId}, sitio ${siteId}`);
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw new InvalidPlanError(routeId, `${name} inválido en punto ${pointId}, sitio ${siteId}`);
    return number;
  }

  private async first(query: string, values: unknown[]): Promise<Row | null> {
    return (await this.sql.query(query, values)).rows[0] ?? null;
  }

  private async read<T>(entity: string, id: number, fetch: () => Promise<T>, forceFresh: boolean): Promise<T> {
    const now = this.options.now?.() ?? new Date();
    const cached = await this.cache.get<T>(entity, id);
    const age = cached ? now.getTime() - Date.parse(cached.fetchedAt) : Infinity;
    if (!forceFresh && cached && age >= 0 && age < (this.options.revalidateMs ?? 300_000)) return cached.value;
    const value = await fetch();
    const dtModificacion = value && !Array.isArray(value) && typeof value === 'object' && 'dt_modificacion' in value
      ? String(value.dt_modificacion ?? '') || null : null;
    const entry: CatalogEntry<T> = { value, dtModificacion, fetchedAt: now.toISOString() };
    if (cached && (JSON.stringify(cached.value) !== JSON.stringify(value) || cached.dtModificacion !== dtModificacion)) {
      this.options.onNotice?.(`Cambio detectado en ${entity} ${id}`);
    }
    await this.cache.set(entity, id, entry);
    return value;
  }
}
