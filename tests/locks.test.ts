import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  behaviourFor, estimate, conflictsWith, blocksReads, blocksWrites, LOCK_ORDER,
  type TableStats,
} from '../src/locks.ts';
import { classify, parseMigration, splitStatements } from '../src/parse.ts';

const ORDERS: TableStats = {
  name: 'orders', rows: 400_000_000, indexes: 4, writesPerSecond: 1_200,
};
const SMALL: TableStats = {
  name: 'feature_flags', rows: 120, indexes: 1, writesPerSecond: 2,
};

describe('the lock conflict matrix', () => {
  test('ACCESS EXCLUSIVE conflicts with everything, including itself', () => {
    for (const m of LOCK_ORDER) {
      assert.ok(conflictsWith('ACCESS EXCLUSIVE', m), `missing conflict with ${m}`);
    }
  });

  test('ACCESS SHARE conflicts only with ACCESS EXCLUSIVE', () => {
    for (const m of LOCK_ORDER) {
      assert.equal(conflictsWith('ACCESS SHARE', m), m === 'ACCESS EXCLUSIVE');
    }
  });

  test('the matrix is symmetric - lock conflict is a mutual relation', () => {
    // An asymmetric entry is a typo, and it silently produces wrong advice in
    // exactly one direction.
    for (const a of LOCK_ORDER) {
      for (const b of LOCK_ORDER) {
        assert.equal(conflictsWith(a, b), conflictsWith(b, a),
          `matrix asymmetry between ${a} and ${b}`);
      }
    }
  });

  test('SHARE UPDATE EXCLUSIVE does not block reads or writes', () => {
    // This is why CREATE INDEX CONCURRENTLY and VALIDATE CONSTRAINT are the
    // recommended rewrites.
    assert.equal(blocksReads('SHARE UPDATE EXCLUSIVE'), false);
    assert.equal(blocksWrites('SHARE UPDATE EXCLUSIVE'), false);
  });

  test('SHARE blocks writes but not reads', () => {
    assert.equal(blocksReads('SHARE'), false);
    assert.equal(blocksWrites('SHARE'), true);
  });
});

describe('THE DIFFERENTIATOR: version-dependent behaviour', () => {
  test('ADD COLUMN ... DEFAULT rewrites on PG 10 and does not on PG 11+', () => {
    assert.equal(behaviourFor('ADD_COLUMN_DEFAULT', 10).tableScan, 'rewrite');
    assert.equal(behaviourFor('ADD_COLUMN_DEFAULT', 11).tableScan, 'none');
    assert.equal(behaviourFor('ADD_COLUMN_DEFAULT', 16).tableScan, 'none');
  });

  test('the same statement gets very different advice per version', () => {
    const sql = 'ALTER TABLE orders ADD COLUMN status text DEFAULT \'new\'';
    const pg10 = estimate('ADD_COLUMN_DEFAULT', 10, ORDERS, sql);
    const pg16 = estimate('ADD_COLUMN_DEFAULT', 16, ORDERS, sql);

    assert.equal(pg10.severity, 'DANGER');
    assert.ok(pg10.estimatedBlockMs > 60_000,
      `expected a long rewrite, got ${pg10.estimatedBlockMs}ms`);
    assert.equal(pg16.severity, 'SAFE');
    assert.ok(pg16.estimatedBlockMs < 100);
    // A version-blind linter reports the PG 10 answer on a PG 16 server. Half
    // its warnings are then visibly false, and users stop reading it.
  });

  test('a volatile default still rewrites, even on PG 16', () => {
    assert.equal(behaviourFor('ADD_COLUMN_VOLATILE_DEFAULT', 16).tableScan, 'rewrite');
  });

  test('unknown versions inherit the nearest lower entry', () => {
    assert.equal(behaviourFor('ADD_COLUMN_DEFAULT', 13).tableScan, 'none');
    assert.equal(behaviourFor('DROP_COLUMN', 17).lock, 'ACCESS EXCLUSIVE');
  });
});

describe('the estimate is actionable, not categorical', () => {
  test('a big hot table gets DANGER with a duration in minutes', () => {
    const r = estimate('ALTER_COLUMN_TYPE', 16, ORDERS, 'alter...');
    assert.equal(r.severity, 'DANGER');
    assert.ok(r.blocksWrites);
    assert.ok(r.estimatedBlockMs > 60_000);
    assert.ok(r.queuedWrites > 10_000,
      'the count of writes that will pile up is the number people act on');
  });

  test('the SAME operation on a small table is SAFE', () => {
    const r = estimate('ALTER_COLUMN_TYPE', 16, SMALL, 'alter...');
    assert.equal(r.severity, 'SAFE');
    assert.ok(r.estimatedBlockMs < 1_000);
    // Severity that ignores table size flags every migration and is ignored.
  });

  test('index count increases the rewrite estimate', () => {
    const few = estimate('ALTER_COLUMN_TYPE', 16,
      { ...ORDERS, indexes: 1 }, 'x');
    const many = estimate('ALTER_COLUMN_TYPE', 16,
      { ...ORDERS, indexes: 9 }, 'x');
    assert.ok(many.estimatedBlockMs > few.estimatedBlockMs);
  });

  test('an operation that does not block writes queues nothing', () => {
    const r = estimate('CREATE_INDEX_CONCURRENTLY', 16, ORDERS, 'x');
    assert.equal(r.blocksWrites, false);
    assert.equal(r.queuedWrites, 0);
    assert.equal(r.severity, 'SAFE');
  });

  test('unrecognised statements are assumed worst case, never assumed safe', () => {
    const r = estimate('UNKNOWN', 16, ORDERS, 'DO $$ ... $$');
    assert.equal(r.severity, 'DANGER');
    assert.match(r.note!, /assumed worst case/);
  });
});

describe('safe rewrites', () => {
  test('SET NOT NULL suggests the NOT VALID two-step', () => {
    const r = estimate('SET_NOT_NULL', 16, ORDERS, 'x');
    assert.match(r.rewrite!, /NOT VALID/);
  });

  test('CREATE INDEX suggests CONCURRENTLY', () => {
    assert.match(estimate('CREATE_INDEX', 16, ORDERS, 'x').rewrite!, /CONCURRENTLY/);
  });

  test('no rewrite is suggested when the operation is already safe on this version', () => {
    assert.equal(estimate('ADD_COLUMN_DEFAULT', 16, ORDERS, 'x').rewrite, undefined);
    assert.match(estimate('ADD_COLUMN_DEFAULT', 10, ORDERS, 'x').rewrite!, /backfill/);
  });
});

describe('statement classification', () => {
  const cases: Array<[string, string]> = [
    ['ALTER TABLE orders ADD COLUMN note text', 'ADD_COLUMN_NULLABLE'],
    ["ALTER TABLE orders ADD COLUMN s text DEFAULT 'new'", 'ADD_COLUMN_DEFAULT'],
    ["ALTER TABLE orders ADD COLUMN s text NOT NULL DEFAULT 'x'",
      'ADD_COLUMN_NOT_NULL_DEFAULT'],
    ['ALTER TABLE orders ADD COLUMN id uuid DEFAULT gen_random_uuid()',
      'ADD_COLUMN_VOLATILE_DEFAULT'],
    ['ALTER TABLE orders DROP COLUMN note', 'DROP_COLUMN'],
    ['ALTER TABLE orders ALTER COLUMN total SET NOT NULL', 'SET_NOT_NULL'],
    ['ALTER TABLE orders ADD CONSTRAINT c CHECK (total > 0)', 'ADD_CHECK'],
    ['ALTER TABLE orders ADD CONSTRAINT c CHECK (total > 0) NOT VALID',
      'ADD_CHECK_NOT_VALID'],
    ['ALTER TABLE orders VALIDATE CONSTRAINT c', 'VALIDATE_CONSTRAINT'],
    ['ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (uid) REFERENCES users(id)',
      'ADD_FOREIGN_KEY'],
    ['CREATE INDEX idx ON orders (uid)', 'CREATE_INDEX'],
    ['CREATE INDEX CONCURRENTLY idx ON orders (uid)', 'CREATE_INDEX_CONCURRENTLY'],
    ['CREATE UNIQUE INDEX CONCURRENTLY idx ON orders (uid)',
      'CREATE_INDEX_CONCURRENTLY'],
    ['DROP INDEX idx', 'DROP_INDEX'],
    ['ALTER TABLE orders ALTER COLUMN total TYPE numeric(12,2)',
      'ALTER_COLUMN_TYPE'],
    ['ALTER TABLE orders RENAME COLUMN a TO b', 'RENAME_COLUMN'],
    ['VACUUM FULL orders', 'VACUUM_FULL'],
    ['SELECT 1', 'UNKNOWN'],
  ];

  for (const [sql, expected] of cases) {
    test(`classifies: ${sql.slice(0, 52)}`, () => {
      assert.equal(classify(sql), expected);
    });
  }

  test('NOT VALID is detected regardless of spacing and case', () => {
    assert.equal(
      classify('alter table t add constraint c check (x>0)   not   valid'),
      'ADD_CHECK_NOT_VALID');
  });
});

describe('migration parsing', () => {
  test('extracts the table name, including schema-qualified names', () => {
    const s = parseMigration('ALTER TABLE public.orders ADD COLUMN a text;');
    assert.equal(s[0]!.table, 'orders');
  });

  test('finds the table for CREATE INDEX', () => {
    const s = parseMigration('CREATE INDEX i ON public.orders (uid);');
    assert.equal(s[0]!.table, 'orders');
  });

  test('strips comments so a commented-out statement is not analysed', () => {
    const sql = `
      -- ALTER TABLE orders DROP COLUMN total;
      ALTER TABLE orders ADD COLUMN note text;
      /* CREATE INDEX i ON orders (uid); */
    `;
    const s = parseMigration(sql);
    assert.equal(s.length, 1);
    assert.equal(s[0]!.operation, 'ADD_COLUMN_NULLABLE');
  });

  test('detects an explicit transaction, which extends every lock to the end', () => {
    const s = parseMigration(
      'BEGIN; ALTER TABLE orders ADD COLUMN a text; CREATE INDEX i ON orders (a); COMMIT;');
    assert.equal(s.length, 2, 'BEGIN/COMMIT are not analysable statements');
    assert.ok(s.every((x) => x.inTransaction));
  });

  test('splitStatements ignores semicolons inside comments', () => {
    assert.equal(splitStatements('-- a; b;\nSELECT 1;').length, 1);
  });
});
