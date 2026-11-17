export interface SqlClient {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
