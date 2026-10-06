export interface RouteAssignment {
  imei: string;
  latitude: number;
  longitude: number;
  radius: number;
  order: number;
}

export interface ChainReportRow {
  idReport: string;
  imei: string;
  raw: string;
}

export interface RouteDetector {
  getActiveRoutes(): Promise<RouteAssignment[]>;
}

export interface ChainReportDetector {
  getNewEvents(): Promise<ChainReportRow[]>;
}
