import type { SqlClient } from '../db/types';
import type { DetectorOptions } from './types';

export const NAMESPACE_SQL = "SELECT oid FROM pg_namespace WHERE nspname = 'tbl_cadena'";
export const PARTITIONS_SQL = "SELECT relname FROM pg_class WHERE relnamespace = $1 AND relkind IN ('r','p') AND relname ~ '^[0-9]{6}$' ORDER BY relname DESC";
export const PARTITION_RECHECK_MS = 60_000;
export const PARTITION_DUAL_READ_MS = 300_000;
const DAY_MS = 86_400_000;
const validName = (name: string): boolean => /^[0-9]{6}$/.test(name);

export function weekLabel(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(ms) || !Number.isFinite(date.getTime())) throw new Error('Fecha UTC inválida para partición.');
  const year = date.getUTCFullYear();
  const day = Math.floor((Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - Date.UTC(year, 0, 1)) / DAY_MS) + 1;
  return `${year}${String(Math.floor((day - 1) / 7) + 1).padStart(2, '0')}`;
}

export function weekStartMs(label: string): number {
  if (!validName(label)) throw new Error(`Etiqueta de partición inválida: ${label}.`);
  const year = Number(label.slice(0, 4));
  const week = Number(label.slice(4));
  const start = Date.UTC(year, 0, 1) + (week - 1) * 7 * DAY_MS;
  if (week < 1 || weekLabel(start) !== label) throw new Error(`Etiqueta de partición inválida: ${label}.`);
  return start;
}

export function previousLabel(label: string): string { return weekLabel(weekStartMs(label) - 1); }

export interface PartitionSelection { partition: string; computed: string; fallback: boolean }

export class PartitionNotKnownError extends Error {
  constructor(public readonly partition: string) {
    super(`Partición no descubierta: ${partition}.`);
    this.name = 'PartitionNotKnownError';
  }
}

export class Partitions {
  private known: Set<string> | null = null;
  private oid: unknown = null;
  private lastCheckAt: number | null = null;
  private inFlight: Promise<void> | null = null;
  private selected: string | null = null;
  private readonly missingAlerted = new Set<string>();

  constructor(private readonly db: SqlClient, private readonly now: () => number,
    private readonly onAlert?: DetectorOptions['onAlert'],
    private readonly onPartitionSelected?: DetectorOptions['onPartitionSelected']) {}

  private async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.lastCheckAt = this.now();
    const work = (async () => {
      if (this.oid === null) this.oid = (await this.db.query(NAMESPACE_SQL, [])).rows[0]?.oid ?? null;
      const rows = this.oid === null ? [] : (await this.db.query(PARTITIONS_SQL, [this.oid])).rows;
      this.known = new Set(rows.map((row) => String(row.relname)).filter(validName));
    })();
    this.inFlight = work;
    try { await work; } finally { this.inFlight = null; }
  }

  async resolveCurrent(nowMs = this.now()): Promise<PartitionSelection> {
    const computed = weekLabel(nowMs);
    if (!this.known?.has(computed) && (this.lastCheckAt === null || nowMs - this.lastCheckAt >= PARTITION_RECHECK_MS))
      await this.refresh();
    else if (this.inFlight && !this.known?.has(computed)) await this.inFlight;
    if (this.known?.has(computed)) return { partition: computed, computed, fallback: false };
    if (!this.missingAlerted.has(computed)) {
      this.missingAlerted.add(computed);
      this.onAlert?.({ code: 'PARTITION_NOT_FOUND', partition: computed,
        message: `La partición calculada ${computed} no existe en el catálogo.` });
    }
    const partition = this.previousKnown(computed);
    if (!partition) throw new Error(`No hay partición anterior disponible para ${computed}.`);
    return { partition, computed, fallback: true };
  }

  previousKnown(label: string): string | null {
    if (!validName(label)) throw new Error(`Etiqueta de partición inválida: ${label}.`);
    return [...(this.known ?? [])].filter((name) => name < label).sort().at(-1) ?? null;
  }
  has(label: string): boolean { return validName(label) && (this.known?.has(label) ?? false); }
  select(selection: PartitionSelection): void {
    if (this.selected === selection.partition) return;
    this.selected = selection.partition;
    this.onPartitionSelected?.(selection);
  }
  quote(name: string): string {
    if (!validName(name) || !this.known?.has(name)) throw new PartitionNotKnownError(name);
    return `tbl_cadena."${name}"`;
  }
}
