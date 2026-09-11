/**
 * The 60-second artefact: the same migration, reviewed against PG 10 and PG 16.
 * Run: `npm run demo`
 */
import { estimate, type TableStats } from './locks.ts';
import { parseMigration } from './parse.ts';

const MIGRATION = `
  -- 2026_03_add_fulfilment_fields.sql
  ALTER TABLE orders ADD COLUMN fulfilment_status text DEFAULT 'pending';
  ALTER TABLE orders ALTER COLUMN total SET NOT NULL;
  CREATE INDEX idx_orders_fulfilment ON orders (fulfilment_status);
  ALTER TABLE orders ADD CONSTRAINT chk_total CHECK (total >= 0) NOT VALID;
`;

const STATS: Record<string, TableStats> = {
  orders: { name: 'orders', rows: 400_000_000, indexes: 4, writesPerSecond: 1_200 },
};

const fmt = (ms: number) =>
  ms < 1_000 ? `${ms}ms`
  : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s`
  : `${(ms / 60_000).toFixed(1)}min`;

console.log('\n  LOCKSMITH - the same migration, two server versions');
console.log('  ' + '-'.repeat(70));
console.log('  Target table: orders, 400,000,000 rows, 4 indexes, 1,200 writes/sec\n');

const statements = parseMigration(MIGRATION);

for (const version of [10, 16]) {
  console.log(`  PostgreSQL ${version}`);
  console.log('  ' + '-'.repeat(70));
  let total = 0;
  for (const s of statements) {
    const stats = STATS[s.table];
    if (!stats) continue;
    const r = estimate(s.operation, version, stats, s.sql);
    total += r.blocksWrites ? r.estimatedBlockMs : 0;
    const flag = r.severity === 'DANGER' ? '!!' : r.severity === 'CAUTION' ? ' !' : '  ';
    console.log(`  ${flag} ${r.operation.padEnd(29)} ${r.lock.padEnd(23)} ` +
                `${fmt(r.estimatedBlockMs).padStart(8)}  ${r.severity}`);
    if (r.severity !== 'SAFE' && r.blocksWrites) {
      console.log(`       blocks writes; ~${r.queuedWrites.toLocaleString('en-US')} ` +
                  'writes queue behind it');
      if (r.note) console.log(`       ${r.note}`);
      if (r.rewrite) console.log(`       rewrite: ${r.rewrite}`);
    }
  }
  console.log(`     total write-blocking time: ${fmt(total)}\n`);
}

console.log('  The first statement is the point. On PG 10 it rewrites 400M rows');
console.log('  and stalls every write for minutes. On PG 11+ it is a catalogue');
console.log('  update that takes milliseconds. A linter that does not know your');
console.log('  server version has to report one of those two answers, and will');
console.log('  be badly wrong roughly half the time.\n');
