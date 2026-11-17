import type { ModelName } from '../protocol';

export interface SqlClient {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface UnitDevice {
  unitId: number;
  companyId: number;
  deviceId: number;
  modelId: number;
  model: ModelName;
}

export interface DeviceDirectory {
  resolveForRouteStart(unitId: number, expectedCompanyId: number): Promise<UnitDevice>;
}

export interface RoutePlanPoint {
  pointId: number;
  order: number;
  siteId: number;
  latitude: number;
  longitude: number;
  radiusM: number;
  radiusAdjusted: boolean;
}

export interface RoutePlan {
  routeType: 0 | 1;
  points: RoutePlanPoint[];
}

export interface RoutePlanRepository {
  getPlan(companyId: number, catalogRouteId: number, opts?: { forceFresh?: boolean }): Promise<RoutePlan>;
}
