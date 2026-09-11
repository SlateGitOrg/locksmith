# locksmith

> A migration linter that predicts PostgreSQL lock duration from real table statistics - verified against real servers, version by version.

`COMPACT` · **Full Stack Engineering** · Advanced · ~5-6 days · High-traffic transactional systems

**Primary language:** TypeScript
**Tags:** `postgres`, `sql`, `static-analysis`, `ci`, `reliability`, `cli`

---

## The problem

A one-line migration adds a column with a default and takes an ACCESS EXCLUSIVE lock. On a 400-million-row table this stalls every write for eleven minutes. The team finds out during the deploy, from the pager, at the point when rolling back is also expensive.

## ⭐ The differentiator

Parses migration SQL and evaluates each statement against the **documented PostgreSQL lock-conflict matrix for the target server version**, then estimates blocking duration from live `pg_stat` table statistics. The warning therefore reads 'this will block writes on orders for ~9 minutes', not 'this statement takes a lock'. A generic linter pattern-matches keywords and gives version-blind advice that is simply wrong for PostgreSQL 11+, where several of these operations stopped being blocking.

This is the sentence to lead with when someone asks you to walk through the
project. Everything else in this repo exists to make it true and to prove it.

## Data

The lock-conflict matrix from the official documentation, encoded as data per major version. Table statistics read from any local PostgreSQL. Fixture migrations drawn from the migration histories of open-source projects.

> No paid API key is required to run or demo this project. Where a paid
> service would add value it is wired as an optional enhancement behind an
> interface with an offline mock as the default implementation.

## Stack

- TypeScript, pgsql-parser (real PostgreSQL grammar, not a regex)
- Node CLI
- Docker running PostgreSQL 13-17 side by side for verification
- Vitest

## Core capabilities

- SQL parsing to a statement-level lock profile, version-aware
- Blocking-duration estimate from row count, index count and observed write rate
- Safe-rewrite suggestions (add-nullable, backfill in batches, NOT VALID then validate)
- CI mode with a risk threshold and an explicit, logged override annotation
- Multi-version verification harness executing each fixture against real PostgreSQL

## Repository layout

```
src/parse/
src/locks/                # the conflict matrix, per version
src/estimate/
fixtures/
test/integration/         # real servers, real concurrent writer
```

## Build plan

1. Encode the lock matrix per version from the official docs. This is the asset; be precise.
2. Parser -> lock profile, then the integration harness that verifies your matrix against real servers.
3. Duration estimation last - it is the least certain part, so label its confidence honestly.

## Testing strategy

The integration suite **actually executes each fixture migration against containerised PostgreSQL 13-17 while a concurrent writer runs**, asserting the predicted lock class matches the observed one. This is the difference between a linter that encodes folklore and one that encodes verified behaviour - and it is what lets you say 'this advice is correct for your server version' out loud.

Tests assert **correctness**, not merely that the code runs. A green suite on
this repo is a claim about behaviour under adversarial conditions; treat any
test that would pass against a deliberately broken implementation as a bug in
the test.

## Measurable outcome

> Lock-risk predictions verified against four PostgreSQL major versions, catching the eleven-minute migration in review rather than in production.

State it in these terms — business units, not technical ones — in your CV
bullet and in the first thirty seconds of describing the project.

## Interview questions this project answers

- **Which DDL operations are safe on a large hot table in PG 16, and which were not in PG 10?**
- **How would you add a NOT NULL column to a 400M-row table with no downtime?**

## What this deliberately is *not*

- Not a migration runner. It reviews; something else applies.


## Verification status

The lock matrix, the statement classifier and the estimator are covered by 41
passing unit tests, including a symmetry check over the full 8x8 conflict
matrix and version-boundary cases for every operation whose behaviour changed.

**The multi-version integration harness has NOT been run in this repository.**
It requires live PostgreSQL 13-17 servers, which were not available on the
machine this was built on. That harness is the part that turns encoded
documentation into verified behaviour, so treat the matrix as *carefully
transcribed* rather than *empirically confirmed* until you have run it:

```bash
docker compose up -d          # PG 13,14,15,16,17
npm run test:integration      # executes each fixture, observes the real lock
```

This distinction matters for the interview. "I encoded the documented matrix"
and "I verified the documented matrix against five server versions under a
concurrent writer" are different claims, and only one of them is currently
true here.


## Run it now

```bash
npm test        # runs the suite; no install step needed
npm run demo    # the 60-second artefact
```

Requires Node 22.6+ (24 recommended). TypeScript runs natively via
type stripping - there is no build step and no `node_modules`.

## Getting started

```bash
git clone <your-fork-url> locksmith
cd locksmith
npm install
docker compose up -d          # PG 13,14,15,16,17
npx locksmith check db/migrations --target 16 --stats-from $DATABASE_URL
npm run test:integration      # predicted vs observed, all versions
```

Docker is supported but optional — every path above works on a plain
Windows/macOS/Linux laptop without a cloud account.

## Definition of done

- [ ] The differentiator above is implemented, and a test proves it
- [ ] The measurable outcome is produced by a command anyone can run
- [ ] `README` explains the one decision a generic version gets wrong
- [ ] CI runs the full suite on every push and is green on `main`
- [ ] A recruiter can see the headline artefact in under 60 seconds

## Licence

MIT — see [LICENSE](LICENSE).
