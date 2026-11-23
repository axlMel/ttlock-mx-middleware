import type { SqlClient } from '../catalog';
import type { ChainQueryLimiter } from '../orchestrator';

const CHAIN_PARTITION = /\btbl_cadena\."[0-9]{6}"/;

/** Limita cada consulta a una partición, incluso si una operación del lector ejecuta varias. */
export function rateLimitedChainSql(db: SqlClient, limiter: ChainQueryLimiter): SqlClient {
  return {
    query: (text, values) => CHAIN_PARTITION.test(text)
      ? limiter.run(() => db.query(text, values))
      : db.query(text, values),
  };
}
