# Measuring what SQLSimCity costs the instance it watches

A local SQL Server, seeded large enough that the numbers mean something, plus a probe
harness that reports elapsed time and logical reads.

This exists because several performance questions on this repository cannot be settled by
reading code. Whether SQL Server pushes a keyset predicate below an aggregate, what a
24-hour Query Store window actually costs, and how either scales with history depth are
facts about a query plan, not about the SQL text. A figure from here is evidence; an
estimate from reading the probe is not — and the review that created issues #74–#83
produced several confident numbers that turned out to be worst-case arithmetic.

Nothing here runs in CI. It is a workbench. Its siblings are `tools/measure-api/`, which
measures what a request costs the API process, and `tools/measure-browser/`, which measures
what the app costs the browser. Both reuse the rig this one stands up.

## Standing it up

```powershell
cd tools/measure
docker compose -f compose.measure.yaml up -d

# ~4 minutes: 4,200 tables across 8 schemas, then rows.
./Initialize-MeasureDatabase.ps1

# Or, if you need history older than the 90-day horizon (see below), ~20 seconds more:
./Initialize-MeasureDatabase.ps1 -DeepHistoryDays 120
```

`Initialize-MeasureDatabase.ps1` runs the three seed scripts and then builds Query Store
history by running the workload repeatedly across several intervals.

Tear down with `docker compose -f compose.measure.yaml down -v`.

## Query Store goes READ_ONLY under backlog, and a seed runs straight through it

Query Store parks itself in `READ_ONLY` when its in-memory backlog reaches an internal limit
rather than failing anything, and it clears itself once the backlog drains. Observed here as
`readonly_reason` 262144 — *the size of in-memory items waiting to be persisted has reached
the internal memory limit* — both on a newly created database and again partway through the
history passes. `QUERY_CAPTURE_MODE = ALL` and 4,200 objects make it easy to reach.

It matters because of how it fails. A workload pass through a `READ_ONLY` store runs to
completion, reports nothing wrong, and captures nothing. **Measured on this rig: a run that
completed normally, printed all eight passes, and left 106 queries and 741 runtime buckets
where an identical run had produced 5,889 and 353,358.** Nothing in the output said so; the
seed simply finished with a near-empty store and a plausible-looking summary. That is worse
than a failure, because everything downstream would then be measuring an empty database.

Three things guard it, and all three are needed:

- `sys.sp_query_store_flush_db` after **every** pass, which drains the backlog so the limit
  is not reached in the first place.
- `seed/wait-query-store-writable.sql` before **every** pass, not just the first. The passes
  are what fills the backlog, so a single check up front leaves later passes free to run
  against a store that is no longer capturing.
- A count check after the passes. One pass issues at least three statements per family, so a
  store holding no more than `FamilyCount` queries means capture was off for most of the run,
  and the seed fails loudly instead of handing on an empty store.

## Two defaults that would quietly ruin a run

Both are set by `seed/01-database.sql`, and both are the kind of thing that produces a
clean-looking measurement of the wrong thing:

- **`QUERY_CAPTURE_MODE = ALL`.** The default `AUTO` discards cheap ad-hoc queries, so a
  seeded workload can run to completion and still leave whole families missing from the
  store. This is already called out in `AGENTS.md` for the plan finder, and it applies to
  every measurement that reads Query Store.
- **`INTERVAL_LENGTH_MINUTES = 1`.** The default of 60 produces one runtime-stats interval
  per hour, so a short seed run yields a single interval. Paging over
  `sys.query_store_runtime_stats` is exercised by interval count multiplied by plan count,
  and one interval cannot exercise it at all.

## Seeding more than 90 days of history

The history above is minutes old. That is right for every probe measurement, and it means
the rig cannot reach anything that only engages on *old* history: the initial backfill cap
added by #87 starts no earlier than `QueryStoreHistory:InitialLookbackDays` (90 days), so
against a store whose oldest interval is four minutes old the cap has nothing to refuse and
never fires. The same is true of a progressive backfill and of a retention prune at the
boundary. #87 was verified by unit tests only, and said so.

Opt in with `-DeepHistoryDays`:

```powershell
# The ordinary seed, then ~20 seconds stretching it over 120 days.
./Initialize-MeasureDatabase.ps1 -DeepHistoryDays 120

# Or against a database that is already seeded, which is the usual case --
# changing the span should not mean paying for the 4,200-object seed again.
./Add-DeepHistory.ps1 -SpanDays 120 -IntervalCount 240
```

It is opt-in because of what it leaves behind rather than what it costs. The store ends up
holding synthesized rows and a `STALE_QUERY_THRESHOLD_DAYS` raised well past the default, and
most measurements neither want nor need either.

### It does not move any clock, and you should not try

The obvious approach is to run the workload with the container's clock in the past, because
`sys.query_store_runtime_stats_interval.start_time` is stamped by the engine and the catalog
views are not writable. Three routes were tried. All are dead, and the first is dead in the
worst possible way — silently.

- **`libfaketime` via `LD_PRELOAD` does nothing to SQL Server.** The library loads: it is
  visible in `ldd /opt/mssql/bin/sqlservr`. It still has no effect on the engine, because
  SQL Server on Linux runs inside SQLPAL and does not take its time through the glibc
  symbols `LD_PRELOAD` interposes. Measured with `FAKETIME=-120d`: the container's `date`
  moved 120 days while `SYSDATETIME()` and every line of the error log stayed on the real
  date. Nothing errors. A run that assumed it worked would produce a store with a four-minute
  span and a confident claim of four months.
- **Linux time namespaces cannot help.** They virtualise `CLOCK_MONOTONIC` and
  `CLOCK_BOOTTIME` and deliberately not `CLOCK_REALTIME`, which is the one that matters.
- **`--cap-add SYS_TIME` plus `date -s` is rejected on purpose.** Containers share the
  host kernel's clock, so under Docker Desktop that means moving the WSL2 VM's clock: every
  other container, the Docker daemon, and anything doing TLS validation moves with it, and
  WSL2 re-syncs from Windows at times of its own choosing, which would corrupt a long seed
  halfway through. This has to be safe to run on a developer machine. **Nothing here requires
  changing the host's time, and nothing here should be changed so that it does.**

So `seed/04-deep-history.sql` relabels the timeline of history the engine really produced.
Every runtime-stats row it leaves behind came from a real execution of a real plan against
the seeded objects; only *when* it happened is rewritten, by writing to Query Store's
backing `plan_persist_*` internal tables over the dedicated admin connection
(`sqlcmd -S admin:localhost`). Those tables accept both `UPDATE` and `INSERT`, and the
public catalog views reflect the change with no restart.

This is unsupported and undocumented. It is fine for a throwaway container whose whole
purpose is to be measured against. **Never point `Add-DeepHistory.ps1` at a database you
care about.**

**And never point it at a store another measurement is already using.** It rewrites the
timeline in place and raises `STALE_QUERY_THRESHOLD_DAYS`, so a probe measurement or a
publish-cost run against the same container silently changes underneath — its numbers stay
plausible and stop describing what it thinks it measured. Two workbench sessions hit this
within an hour of each other: the shared `sqlsimcity-measure-sql` on 11433 was in use, and
the deep-history run stood up its own container on a second port instead. Do that. A 4 GB
limit and a few hundred objects is enough, because what this path needs is interval *span*,
not a large catalog — the 4,200-object floor below is about the browser's page walk and has
nothing to do with backfill depth.

### Why the real intervals move to the far end

The real intervals are back-dated to the *old* end of the span and the synthesized ones fill
forward from them, rather than the other way round. That is not cosmetic. The collector pages
runtime stats with a keyset over `runtime_stats_interval_id` inside a time window, so a store
whose ids run backwards against its timestamps is not the thing being simulated, however
convincing its span looks. `seed/06-verify-deep-history.sql` reports
`id_time_order_violations` for exactly this reason, and it should always be `0`.

### The interval-id counter does not read the table, and the fix is a Query Store cycle

This is the trap that makes a naive version of this script work perfectly until it doesn't.
Query Store's interval-id counter is not derived from `plan_persist_runtime_stats_interval`.
Measured: with interval id `900001` already inserted, the next interval the engine created
was id `2`; and a later insert of id `4` failed with a duplicate key on
`plan_persist_runtime_stats_interval_cidx`, because the engine had already taken it. Left
alone, a store with synthesized ids works fine until the next interval rolls over and then
collides inside Query Store's own clustered index.

Cycling `QUERY_STORE` off and on makes the engine re-derive the counter from the persisted
maximum — measured, after the cycle the next interval it created was `900002`. That is what
`seed/05-query-store-reseat.sql` is for, and it is not optional. It also discards Query
Store's in-memory state and reloads from disk, which is what makes the verification
afterwards worth reading: without it the catalog views would still be serving partly from
memory, so a "120-day span" could be reporting rows that exist only in this instance's RAM.

**The cycle does not preserve Query Store's settings.** They revert to the server defaults,
so `QUERY_CAPTURE_MODE` goes back to `AUTO` and `INTERVAL_LENGTH_MINUTES` back to `60` — the
exact two defaults this rig exists to override, silently restored by the operation that keeps
the id counter honest. Measured: after a cycle, a workload query ran to completion and was
not captured at all. `05-query-store-reseat.sql` reads the live options *before* the cycle
and replays them afterwards, then fails loudly if they did not survive. It reads them rather
than restating them so it cannot drift from `01-database.sql`.

`Add-DeepHistory.ps1` finishes by running one small workload pass and checking that a
genuinely new interval appeared. An id collision shows up nowhere in the row counts; it shows
up the next time the engine tries to open an interval, so that pass is the only evidence the
counter was re-derived rather than left to collide later. One pass is enough because the
counter is re-derived once: if the first allocation lands, every later one does too.
`-SkipLiveProof` removes it, and removes the only check that the store still works.

### Query Store retention will delete the history you just made

`STALE_QUERY_THRESHOLD_DAYS` bounds how far back the store keeps anything, and the rig's
default is 30 days. That is ample for a fast path whose history is minutes old, and it is
silently fatal for a deep-history run: relabel the intervals as four months old and the
background cleanup task is entitled to delete exactly what you seeded. `Add-DeepHistory.ps1`
raises it to `SpanDays + 30` before it touches anything, and `Initialize-MeasureDatabase.ps1
-DeepHistoryDays` passes the same value into `01-database.sql` so the store is never briefly
configured to prune its own contents.

`SIZE_BASED_CLEANUP_MODE = AUTO` is the other end of the same problem. It evicts oldest-first
once the store passes 90% of `MAX_STORAGE_SIZE_MB`, so it eats the deep end first. At the
default 2,048 MB the measured run below sits at 303 MB, nowhere near it — but replicating a
large store across a large `-IntervalCount` is exactly how you get there, so check
`current_storage_size_mb` in the verification output before assuming.

### What it costs, and what it does not give you

Sixteen seconds on top of the ordinary seed, at the defaults, against a store of 5,894
captured query families. It is bought once: the result is on disk in the database and survives
a container restart intact — measured, with the oldest interval still 120 days old and
`ALL`/`1` still in force afterwards. There is no need to `docker commit` anything or keep a
prepared volume around.

A run at the defaults produces:

| | |
| --- | ---: |
| intervals | 241 |
| span | 120 days |
| intervals older than the 90-day horizon | 61 |
| `id_time_order_violations` | 0 |
| queries / plans | 5,901 / 5,901 |
| runtime buckets | 372,847 |
| wait buckets | 11,416 |
| `current_storage_size_mb` | 303 |

Interval *density* is the honest limitation. `-IntervalCount` slots the store evenly across
the span, so 240 intervals over 120 days is one every twelve hours. A real 120-day store at
`INTERVAL_LENGTH_MINUTES = 1` would hold 172,800 of them. Raising `-IntervalCount` costs
storage and seed time in proportion, and the script refuses a count high enough to make the
slots overlap. What this rig gives you is *span* — enough to make the 90-day horizon a real
boundary with data on both sides of it — not a faithful reproduction of a production store's
shape.

## Why 4,200 objects

The browser walks up to `AUTO_PAGE_LIMIT` (80) pages of `CITY_PAGE_SIZE` (50) objects
automatically, so a database has to exceed 4,000 objects before that ceiling is reachable.
Below it, any measurement of the automatic backfill measures a database that finishes early
and proves nothing about the case the issue describes.

## Measuring a probe

```powershell
./Measure-Probe.ps1 -Probe sql/probes/querystore/query_store_database_workload_summary_2022.sql `
    -Parameters @{ StartTime='2020-01-01T00:00:00'; EndTime='2030-01-01T00:00:00' }
```

Parameters are bound with `sp_executesql` rather than substituted as literals, so the
measured statement is parameterized exactly as the collector issues it. A
literal-substituted variant can get a different plan, which would measure the wrong thing.

The first iteration is discarded as a warm-up so compilation does not dominate. Logical
reads are parsed from `SET STATISTICS IO`, and CPU and elapsed from `SET STATISTICS TIME`,
so the figures are work the engine did. **Quote `MedianServerMs`, `MedianCpuMs` and
`MedianReads`, never `MedianHarnessMs`** — `docker exec` and sqlcmd start-up add roughly
300 ms per invocation, which swamps a probe that costs 15 ms server-side. A probe that
errors throws rather than reporting a plausible-looking wall time — an earlier version of
this script silently measured failed batches.

Use `-ShowPlan` to capture the estimated plan instead of executing.

## A worked example: settling issue #81

`query_store_runtime_page_2022.sql` aggregates a CTE over the whole `@StartTime..@EndTime`
window and applies the keyset predicate outside it. Reviewers disagreed about whether that
matters, because SQL Server is *permitted* to push a predicate on grouping columns below the
aggregate.

Vary only the cursor and watch logical reads:

| cursor | CPU ms | logical reads |
| --- | ---: | ---: |
| `AfterIntervalId=0` | 25 | 704 |
| `AfterIntervalId=2` | 26 | 704 |
| `AfterIntervalId=4` | 16 | 704 |
| `AfterIntervalId=6` | 12 | 704 |
| `AfterIntervalId=8` | 7 | 704 |

Reads are **constant** regardless of how far through the result set the cursor is. CPU falls
because fewer rows survive the outer filter and `TOP`, but the aggregation input never
shrinks. The control confirms the reads are real and window-driven rather than fixed
overhead: the same probe over an empty window reads **3** pages against **960** for the full
one.

So the predicate is not being pushed down, each page re-reads the whole window, and cost is
O(window) per page rather than O(page). That is a measurement, and it is what should decide
whether the SQL gets rewritten.

Measured against 5,870 queries / 9,059 runtime buckets over 8 intervals — a small store.
The *shape* is what generalizes; re-run against a deeper history before quoting absolute
numbers.
