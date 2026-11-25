import type { ChainCursor } from '../persistence';

export interface AssignmentRow {
  assignmentId: number; companyId: number; unitId: number; catalogRouteId: number;
  estado: number; enUso: boolean; horaInicial: Date; horaFinal: Date | null; modificadoEn: string | null;
}
export interface AssignmentDetector {
  listVigentes(companyId: number): Promise<AssignmentRow[]>;
  getById(assignmentId: number): Promise<AssignmentRow | null>;
}
export interface ChainFrame { frameId: number; deviceId: number; receivedAt: string; raw: Buffer }
export interface ChainAlert {
  code: 'PARTITION_UNREADABLE' | 'PARTITION_NOT_FOUND' | 'CHAIN_WINDOW_SATURATED';
  partition: string; message: string;
}
export interface ChainReader {
  initCursor(deviceId: number): Promise<ChainCursor>;
  readNew(deviceId: number, cursor: ChainCursor): Promise<{ frames: ChainFrame[]; cursor: ChainCursor; hasMore: boolean }>;
}
export interface DetectorOptions {
  assignmentTz: string; chainBatchLimit: number; chainOverlapMs: number;
  now?: () => number; onAlert?: (alert: ChainAlert) => void;
  onPartitionSelected?: (event: { partition: string; computed: string; fallback: boolean }) => void;
}
