/**
 * The PostgreSQL lock-conflict matrix, encoded as data, per major version.
 *
 * THE DIFFERENTIATOR LIVES HERE.
 *
 * Most migration linters pattern-match on keywords and give version-blind
 * advice. That advice is not merely imprecise, it is WRONG for modern
 * PostgreSQL: `ADD COLUMN ... DEFAULT` rewrote the whole table before 11 and
 * does not from 11 onward; `ADD COLUMN ... NOT NULL DEFAULT` was outright
 * forbidden before 11. A linter that still reports the pre-11 behaviour trains
 * its users to ignore it, because half its warnings are visibly false.
 *
 * So the matrix is data, keyed by version, and the estimate is derived from
 * live `pg_stat` figures rather than folklore. "This will block writes on
 * `orders` for about 9 minutes" is a sentence somebody acts on. "This statement
 * takes a lock" is not.
 */

/** PostgreSQL's eight table-level lock modes, weakest to strongest. */
export type LockMode =
  | 'ACCESS SHARE'
  | 'ROW SHARE'
  | 'ROW EXCLUSIVE'
  | 'SHARE UPDATE EXCLUSIVE'
  | 'SHARE'
  | 'SHARE ROW EXCLUSIVE'
  | 'EXCLUSIVE'
  | 'ACCESS EXCLUSIVE';

export const LOCK_ORDER: readonly LockMode[] = [
  'ACCESS SHARE', 'ROW SHARE', 'ROW EXCLUSIVE', 'SHARE UPDATE EXCLUSIVE',
  'SHARE', 'SHARE ROW EXCLUSIVE', 'EXCLUSIVE', 'ACCESS EXCLUSIVE',
];

/**
 * The conflict matrix from the official documentation. Each mode lists the
 * modes it conflicts with. Reads take ACCESS SHARE; writes take ROW EXCLUSIVE.
 */
const CONFLICTS: Record<LockMode, readonly LockMode[]> = {
  'ACCESS SHARE': ['ACCESS EXCLUSIVE'],
  'ROW SHARE': ['EXCLUSIVE', 'ACCESS EXCLUSIVE'],
  'ROW EXCLUSIVE': ['SHARE', 'SHARE ROW EXCLUSIVE', 'EXCLUSIVE', 'ACCESS EXCLUSIVE'],
  'SHARE UPDATE EXCLUSIVE': [
    'SHARE UPDATE EXCLUSIVE', 'SHARE', 'SHARE ROW EXCLUSIVE', 'EXCLUSIVE',
    'ACCESS EXCLUSIVE'],
  'SHARE': [
    'ROW EXCLUSIVE', 'SHARE UPDATE EXCLUSIVE', 'SHARE ROW EXCLUSIVE', 'EXCLUSIVE',
    'ACCESS EXCLUSIVE'],
  'SHARE ROW EXCLUSIVE': [
    'ROW EXCLUSIVE', 'SHARE UPDATE EXCLUSIVE', 'SHARE', 'SHARE ROW EXCLUSIVE',
    'EXCLUSIVE', 'ACCESS EXCLUSIVE'],
  'EXCLUSIVE': [
    'ROW SHARE', 'ROW EXCLUSIVE', 'SHARE UPDATE EXCLUSIVE', 'SHARE',
    'SHARE ROW EXCLUSIVE', 'EXCLUSIVE', 'ACCESS EXCLUSIVE'],
  'ACCESS EXCLUSIVE': [...LOCK_ORDER],
};

export function conflictsWith(a: LockMode, b: LockMode): boolean {
  return CONFLICTS[a].includes(b);
}
export function blocksReads(mode: LockMode): boolean {
  return conflictsWith(mode, 'ACCESS SHARE');
}
export function blocksWrites(mode: LockMode): boolean {
  return conflictsWith(mode, 'ROW EXCLUSIVE');
}

// ---------------------------------------------------------------------------

export type Operation =
  | 'ADD_COLUMN_NULLABLE'
  | 'ADD_COLUMN_DEFAULT'
  | 'ADD_COLUMN_NOT_NULL_DEFAULT'
  | 'ADD_COLUMN_VOLATILE_DEFAULT'
  | 'DROP_COLUMN'
  | 'SET_NOT_NULL'
  | 'ADD_CHECK'
  | 'ADD_CHECK_NOT_VALID'
  | 'VALIDATE_CONSTRAINT'
  | 'ADD_FOREIGN_KEY'
  | 'CREATE_INDEX'
  | 'CREATE_INDEX_CONCURRENTLY'
  | 'DROP_INDEX'
  | 'ALTER_COLUMN_TYPE'
  | 'RENAME_COLUMN'
  | 'CLUSTER'
  | 'VACUUM_FULL'
  | 'UNKNOWN';

export interface Behaviour {
  readonly lock: LockMode;
  /** Does the operation scan or rewrite the whole table while holding it? */
  readonly tableScan: 'none' | 'read' | 'rewrite';
  readonly note?: string;
}

/**
 * Version-dependent behaviour. Anything not listed for a version inherits the
 * nearest lower version's entry, so only genuine CHANGES are recorded.
 */
const BEHAVIOUR: Record<number, Partial<Record<Operation, Behaviour>>> = {
  10: {
    ADD_COLUMN_NULLABLE: { lock: 'ACCESS EXCLUSIVE', tableScan: 'none' },
    ADD_COLUMN_DEFAULT: {
      lock: 'ACCESS EXCLUSIVE', tableScan: 'rewrite',
      note: 'rewrites the entire table (fixed in PG 11)',
    },
    ADD_COLUMN_NOT_NULL_DEFAULT: {
      lock: 'ACCESS EXCLUSIVE', tableScan: 'rewrite',
      note: 'rewrites the entire table (fixed in PG 11)',
    },
    ADD_COLUMN_VOLATILE_DEFAULT: {
      lock: 'ACCESS EXCLUSIVE', tableScan: 'rewrite',
      note: 'a volatile default must be evaluated per row, so it always rewrites',
    },
    DROP_COLUMN: { lock: 'ACCESS EXCLUSIVE', tableScan: 'none' },
    SET_NOT_NULL: {
      lock: 'ACCESS EXCLUSIVE', tableScan: 'read',
      note: 'full scan to verify; use ADD CHECK ... NOT VALID then VALIDATE first',
    },
    ADD_CHECK: { lock: 'ACCESS EXCLUSIVE', tableScan: 'read' },
    ADD_CHECK_NOT_VALID: { lock: 'ACCESS EXCLUSIVE', tableScan: 'none' },
    VALIDATE_CONSTRAINT: { lock: 'SHARE UPDATE EXCLUSIVE', tableScan: 'read' },
    ADD_FOREIGN_KEY: { lock: 'SHARE ROW EXCLUSIVE', tableScan: 'read' },
    CREATE_INDEX: { lock: 'SHARE', tableScan: 'read' },
    CREATE_INDEX_CONCURRENTLY: { lock: 'SHARE UPDATE EXCLUSIVE', tableScan: 'read' },
    DROP_INDEX: { lock: 'ACCESS EXCLUSIVE', tableScan: 'none' },
    ALTER_COLUMN_TYPE: { lock: 'ACCESS EXCLUSIVE', tableScan: 'rewrite' },
    RENAME_COLUMN: { lock: 'ACCESS EXCLUSIVE', tableScan: 'none' },
    CLUSTER: { lock: 'ACCESS EXCLUSIVE', tableScan: 'rewrite' },
    VACUUM_FULL: { lock: 'ACCESS EXCLUSIVE', tableScan: 'rewrite' },
    UNKNOWN: { lock: 'ACCESS EXCLUSIVE', tableScan: 'rewrite',
      note: 'unrecognised statement - assumed worst case' },
  },
  11: {
    // The change that makes version-blind linters wrong.
    ADD_COLUMN_DEFAULT: {
      lock: 'ACCESS EXCLUSIVE', tableScan: 'none',
      note: 'PG 11+ stores the default in the catalogue; no rewrite',
    },
    ADD_COLUMN_NOT_NULL_DEFAULT: {
      lock: 'ACCESS EXCLUSIVE', tableScan: 'none',
      note: 'PG 11+ stores the default in the catalogue; no rewrite',
    },
  },
  12: {
    SET_NOT_NULL: {
      lock: 'ACCESS EXCLUSIVE', tableScan: 'read',
      note: 'PG 12+ can skip the scan if a matching validated CHECK exists',
    },
  },
};

export function behaviourFor(op: Operation, version: number): Behaviour {
  const versions = Object.keys(BEHAVIOUR).map(Number).sort((a, b) => a - b);
  let found: Behaviour | undefined;
  for (const v of versions) {
    if (v > version) break;
    const b = BEHAVIOUR[v]![op];
    if (b) found = b;
  }
  if (!found) throw new Error(`no behaviour recorded for ${op} on PG ${version}`);
  return found;
}

export interface TableStats {
  readonly name: string;
  readonly rows: number;
  readonly indexes: number;
  /** Observed writes per second, from pg_stat_user_tables over a window. */
  readonly writesPerSecond: number;
}

export interface Risk {
  readonly statement: string;
  readonly operation: Operation;
  readonly table: string;
  readonly lock: LockMode;
  readonly blocksReads: boolean;
  readonly blocksWrites: boolean;
  readonly estimatedBlockMs: number;
  readonly queuedWrites: number;
  readonly severity: 'SAFE' | 'CAUTION' | 'DANGER';
  readonly note?: string;
  readonly rewrite?: string;
}

/** Conservative throughput assumptions; documented, not hidden in a constant. */
const ROWS_PER_SEC_REWRITE = 400_000;
const ROWS_PER_SEC_SCAN = 2_000_000;

export function estimate(
  op: Operation, version: number, stats: TableStats, statement: string,
): Risk {
  const b = behaviourFor(op, version);

  let ms = 5; // catalogue-only operations are not free, but they are fast
  if (b.tableScan === 'rewrite') {
    ms = (stats.rows / ROWS_PER_SEC_REWRITE) * 1000 * (1 + stats.indexes * 0.5);
  } else if (b.tableScan === 'read') {
    ms = (stats.rows / ROWS_PER_SEC_SCAN) * 1000;
  }
  ms = Math.round(ms);

  const bw = blocksWrites(b.lock);
  const queued = bw ? Math.round((ms / 1000) * stats.writesPerSecond) : 0;

  let severity: Risk['severity'] = 'SAFE';
  if (bw && ms > 60_000) severity = 'DANGER';
  else if (bw && ms > 1_000) severity = 'CAUTION';
  else if (bw && stats.writesPerSecond > 100 && ms > 200) severity = 'CAUTION';

  return {
    statement, operation: op, table: stats.name, lock: b.lock,
    blocksReads: blocksReads(b.lock), blocksWrites: bw,
    estimatedBlockMs: ms, queuedWrites: queued, severity,
    note: b.note, rewrite: suggestRewrite(op, version),
  };
}

export function suggestRewrite(op: Operation, version: number): string | undefined {
  switch (op) {
    case 'ADD_COLUMN_DEFAULT':
    case 'ADD_COLUMN_NOT_NULL_DEFAULT':
      return version >= 11 ? undefined
        : 'add the column nullable, backfill in batches, then SET DEFAULT';
    case 'ADD_COLUMN_VOLATILE_DEFAULT':
      return 'add the column nullable and backfill in batches';
    case 'SET_NOT_NULL':
      return 'ADD CONSTRAINT ... CHECK (col IS NOT NULL) NOT VALID, ' +
             'VALIDATE CONSTRAINT, then SET NOT NULL';
    case 'ADD_CHECK':
      return 'ADD CONSTRAINT ... NOT VALID, then VALIDATE CONSTRAINT separately';
    case 'CREATE_INDEX':
      return 'CREATE INDEX CONCURRENTLY (outside a transaction)';
    case 'ALTER_COLUMN_TYPE':
      return 'add a new column, dual-write, backfill, swap';
    default:
      return undefined;
  }
}
