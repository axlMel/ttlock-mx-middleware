import type { SqlClient } from '../db/types';
import type { ChainAlert } from './types';

export const NAMESPACE_SQL = "SELECT oid FROM pg_namespace WHERE nspname = 'tbl_cadena'";
export const PARTITIONS_SQL = "SELECT relname FROM pg_class WHERE relnamespace = $1 AND relkind IN ('r','p') AND relname ~ '^[0-9]{6}$' ORDER BY relname DESC LIMIT 2";

export class Partitions {
  private names: string[] = [];
  private known = new Set<string>();
  private refreshedAt: number | null = null;

  constructor(private readonly db: SqlClient, private readonly refreshMs: number,
    private readonly now: () => number, private readonly onAlert?: (alert: ChainAlert) => void) {}

  async current(): Promise<string[]> {
    const now = this.now();
    if (this.refreshedAt !== null && now - this.refreshedAt < this.refreshMs) return this.names;
    const namespace = (await this.db.query(NAMESPACE_SQL, [])).rows[0];
    const rows = namespace ? (await this.db.query(PARTITIONS_SQL, [namespace.oid])).rows : [];
    const names = rows.map((row) => String(row.relname));
    for (const name of names) {
      if (!/^[0-9]{6}$/.test(name)) throw new Error(`Nombre de partición inválido: ${name}.`);
    }
    for (const name of this.names) {
      if (!names.includes(name)) this.onAlert?.({ code: 'PARTITION_DISAPPEARED', partition: name, message: `Desapareció la partición ${name}.` });
    }
    this.names = names;
    names.forEach((name) => this.known.add(name));
    this.refreshedAt = now;
    return names;
  }

  quote(name: string): string {
    if (!/^[0-9]{6}$/.test(name) || !this.known.has(name)) throw new Error(`Nombre de partición inválido o no descubierto: ${name}.`);
    return `tbl_cadena."${name}"`;
  }
}
