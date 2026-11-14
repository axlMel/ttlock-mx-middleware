import type { Pool } from 'pg';
import type { PollingCursorStore } from '../persistence/cursorStore';
import type { ChainReportDetector, ChainReportRow } from './types';

interface ReportRow {
  id_report: string;
  imei: string;
  trama: string;
}

const REPORT_SOURCE = 'reporte_cadenas';
const NEW_EVENTS_QUERY =
  'SELECT id_report, imei, trama FROM reporte_cadenas WHERE id_report > $1 ORDER BY id_report LIMIT 3000';

export class PgChainReportDetector implements ChainReportDetector {
  constructor(
    private readonly pool: Pool,
    private readonly cursorStore: PollingCursorStore,
  ) {}

  async getNewEvents(): Promise<ChainReportRow[]> {
    const cursor = (await this.cursorStore.get(REPORT_SOURCE)) ?? '0';
    const result = await this.pool.query<ReportRow>(NEW_EVENTS_QUERY, [cursor]);
    const events = result.rows.map((row) => ({
      idReport: String(row.id_report),
      imei: row.imei,
      raw: row.trama,
    }));

    const lastEvent = events.at(-1);
    if (lastEvent) {
      await this.cursorStore.set(REPORT_SOURCE, lastEvent.idReport);
    }

    return events;
  }
}
