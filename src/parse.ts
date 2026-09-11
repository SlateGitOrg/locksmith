import type { Operation } from './locks.ts';

/**
 * Classify migration statements.
 *
 * Production should use `pgsql-parser`, which embeds the real PostgreSQL
 * grammar. This is a focused classifier over the DDL that actually appears in
 * migrations, written so the classification rules - and their ordering, which
 * is where these go wrong - are inspectable.
 */

export interface ParsedStatement {
  readonly sql: string;
  readonly operation: Operation;
  readonly table: string;
  readonly inTransaction: boolean;
}

const VOLATILE = /\b(now|clock_timestamp|random|gen_random_uuid|uuid_generate_v4|nextval)\s*\(/i;

function tableOf(sql: string): string {
  const m =
    /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w".]+)/i.exec(sql) ??
    /(?:create|drop)\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+(?:not\s+)?exists\s+)?[\w".]*\s*(?:on\s+([\w".]+))?/i.exec(sql) ??
    /(?:cluster|vacuum\s+full)\s+([\w".]+)/i.exec(sql);
  const raw = (m?.[1] ?? '').replace(/"/g, '');
  return raw.includes('.') ? raw.split('.').pop()! : raw;
}

export function classify(sql: string): Operation {
  const s = sql.trim().replace(/\s+/g, ' ');

  if (/^create\s+(unique\s+)?index\s+concurrently/i.test(s)) {
    return 'CREATE_INDEX_CONCURRENTLY';
  }
  if (/^create\s+(unique\s+)?index/i.test(s)) return 'CREATE_INDEX';
  if (/^drop\s+index/i.test(s)) return 'DROP_INDEX';
  if (/^cluster\b/i.test(s)) return 'CLUSTER';
  if (/^vacuum\s+full/i.test(s)) return 'VACUUM_FULL';

  if (/^alter\s+table/i.test(s)) {
    if (/\badd\s+column\b/i.test(s)) {
      const hasDefault = /\bdefault\b/i.test(s);
      const notNull = /\bnot\s+null\b/i.test(s);
      if (hasDefault && VOLATILE.test(s)) return 'ADD_COLUMN_VOLATILE_DEFAULT';
      if (hasDefault && notNull) return 'ADD_COLUMN_NOT_NULL_DEFAULT';
      if (hasDefault) return 'ADD_COLUMN_DEFAULT';
      return 'ADD_COLUMN_NULLABLE';
    }
    if (/\bdrop\s+column\b/i.test(s)) return 'DROP_COLUMN';
    if (/\bvalidate\s+constraint\b/i.test(s)) return 'VALIDATE_CONSTRAINT';
    if (/\badd\s+constraint\b.*\bforeign\s+key\b/i.test(s)) return 'ADD_FOREIGN_KEY';
    if (/\badd\s+constraint\b.*\bcheck\b/i.test(s)) {
      // Order matters: NOT VALID is the whole difference between a full scan
      // under ACCESS EXCLUSIVE and a catalogue-only change.
      return /\bnot\s+valid\b/i.test(s) ? 'ADD_CHECK_NOT_VALID' : 'ADD_CHECK';
    }
    if (/\bset\s+not\s+null\b/i.test(s)) return 'SET_NOT_NULL';
    if (/\balter\s+column\b.*\btype\b/i.test(s) || /\balter\s+column\b.*\bset\s+data\s+type\b/i.test(s)) {
      return 'ALTER_COLUMN_TYPE';
    }
    if (/\brename\s+column\b/i.test(s)) return 'RENAME_COLUMN';
  }
  return 'UNKNOWN';
}

/** Split a migration file into statements, ignoring comments and strings. */
export function splitStatements(sqlFile: string): string[] {
  const cleaned = sqlFile
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return cleaned.split(';').map((s) => s.trim()).filter(Boolean);
}

export function parseMigration(sqlFile: string): ParsedStatement[] {
  const statements = splitStatements(sqlFile);
  // A migration wrapped in BEGIN/COMMIT holds every lock it takes until the
  // end, so the blocking window is the SUM of its statements, not the max.
  const explicitTx = statements.some((s) => /^begin\b/i.test(s.trim()));
  return statements
    .filter((s) => !/^(begin|commit|rollback)\b/i.test(s))
    .map((sql) => ({
      sql,
      operation: classify(sql),
      table: tableOf(sql),
      inTransaction: explicitTx,
    }));
}
