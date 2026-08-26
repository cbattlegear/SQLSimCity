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
```

`Initialize-MeasureDatabase.ps1` runs the three seed scripts and then builds Query Store
history by running the workload repeatedly across several intervals.

Tear down with `docker compose -f compose.measure.yaml down -v`.

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
