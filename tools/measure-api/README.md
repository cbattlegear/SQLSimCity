# Measuring what a request costs the API process

A real API process, in connected mode, against the rig next door, driven over HTTP from one
warm `HttpClient` — and numbers for the thing neither other workbench can see: what the
server spends between receiving a request and putting the last byte of the response on the
wire.

`tools/measure/` measures what a probe costs the SQL Server being watched.
`tools/measure-browser/` measures what the app costs the browser. This is the tier in
between, and it was the one nobody could measure without rebuilding a harness first.

PR #94 needed exactly this to size the findings recompute. `/api/v1/findings/status`
measured **388.59 ms**, of which the rules were **1.67 ms** — that split was the entire
argument for the change, and fixture mode reported **0.72 ms** and would have proved
nothing. That harness was scratch and was correctly deleted before the pull request
(`AGENTS.md`: one-off scaffolding does not get committed), which left the next person
rebuilding it from zero. This is that harness, kept.

Nothing here runs in CI. It is a workbench.

## Standing it up

The API needs a real target, and there is already a rig for that. Do not stand up a second
one — see `tools/measure/README.md` for why 4,200 objects is the floor and why
`QUERY_CAPTURE_MODE = ALL` and `INTERVAL_LENGTH_MINUTES = 1` are load-bearing:

```powershell
cd tools/measure
docker compose -f compose.measure.yaml up -d
./Initialize-MeasureDatabase.ps1        # ~10 minutes
```

Then one command, from a clean shell:

```powershell
cd tools/measure-api
./Measure-Api.ps1
```

That publishes the API in Release, starts it on `127.0.0.1:5099` in connected mode against
the rig, waits for Atlas and Query Store to publish, measures, prints a table, and stops the
process. Re-running reuses the publish; `-Rebuild` forces a fresh one. It takes no arguments
because every default is the thing you almost certainly want, and each of those defaults is
a trap below.

Useful variations:

```powershell
# The pair from the issue: something that does no work, against something that does.
./Measure-Api.ps1 -Route '/healthz', '/api/v1/findings/status' -Iterations 30

# What compression saves on the wire and what it costs in time.
./Measure-Api.ps1 -AcceptEncoding 'br, gzip', 'identity'

# A comparable pair of runs. -ResetStore on BOTH, or the second one is slower for free.
./Measure-Api.ps1 -ResetStore -Json before.json -Label before
./Measure-Api.ps1 -ResetStore -Json after.json  -Label after

# Leave the server up afterwards, e.g. to point tools/measure-browser at it.
./Measure-Api.ps1 -KeepRunning
```

## The traps

Every one of these produced a wrong number here at least once, and most of them produce a
*plausible* wrong number, which is worse.

### The rate limiter turns a benchmark into a measurement of 429s

`HttpSecurity:ApiPermitLimit` defaults to **600 requests per 60 seconds**, partitioned by
client address. A benchmark exhausts that in seconds and then measures the rejection path.
During #84 a loop did exactly this and reported 44-byte rejection bodies as though they were
responses.

Three defences, because the failure is silent:

- **The limit is raised.** When this script starts the API it sets
  `HttpSecurity__ApiPermitLimit` to 10000, the configured maximum.
- **The budget is checked before anything starts.** The script counts the requests the run
  will issue and refuses up front rather than discovering it 40 requests in. It is
  deliberately conservative: it assumes the whole run lands inside one fixed window, which a
  run longer than `ApiWindowSeconds` does not.
- **A 429 is fatal and cannot be waived.** `-ExpectStatus` widens what counts as success,
  and passing `429` to it is rejected outright — a run that tolerated 429 would be reporting
  the rate limiter as if it were the API.

Only `/api` is rate limited: `UseSqlSimCityHttpSecurity` wraps the limiter in
`UseWhen(path.StartsWithSegments("/api"))`. So `/healthz` and `/readyz` cost no permits,
which is why the floor route stays trustworthy through a long run.

When you point `-BaseUrl` at a server you started yourself, only the third defence applies.
`-ApiPermitLimit` is then your *assertion* about that server, not a setting.

### Fixture mode measures nothing, convincingly

This is the trap that makes the whole workbench necessary, and it does not look like a
failure — it produces a full table of small, stable, entirely meaningless numbers. Same
harness, same iteration count, same machine, only the mode differs:

| route | fixture, over floor | connected, over floor | ratio |
| --- | ---: | ---: | ---: |
| `/api/v1/query-store/queries?pageSize=50` | 0.04 ms | 9.63 ms | **241×** |
| `/api/v1/findings/status` | 0.35 ms | 4.52 ms | 13× |
| `/api/v1/findings/` | 0.47 ms | 4.49 ms | 10× |

The fixture total for `/api/v1/findings/status` was **0.74 ms**, which is #94's 0.72 ms
again. So the script drives connected mode by default and there is no `-Fixture` switch to
reach for by accident.

### A connected server is not a ready one

A connected API serves an **empty** evidence bundle until the first Atlas collection lands,
and an empty bundle makes every `/api/v1/findings/*` route cost almost nothing. Measuring in
that window produces fixture-shaped numbers from a genuinely connected server — the same
wrong answer, reached by a route the mode check cannot catch. Query Store is the slower half
and the one that actually costs anything, and it publishes asynchronously after that.

So the script waits for both, and says so:

```
Atlas collected 5 databases in 10182 ms.
Query Store published at 8/26/2026 10:56:02 AM (Ready).
```

If those two lines are missing from your output, you were not measuring what you think.
`-SkipCollectorWait` exists, and it is only correct when the empty bundle is the thing you
came to measure.

### The protected store persists between runs, so "after" is slower for free

Every route worth measuring here reads the protected store, the collector keeps filling it,
and it survives in `%TEMP%\sqlsimcity-measure-api-data` from one run to the next. A "before"
and an "after" taken back to back are therefore not comparable: the second one reads a larger
store.

This is not theoretical. Across three runs of the same unchanged build, the
`/api/v1/query-store/queries` body grew 68,269 → 106,339 → 109,580 bytes and its median went
7.84 → 11.75 ms — a 50% "regression" caused entirely by the harness's own history.

`-ResetStore` clears it first. Use it on **both** runs of a comparison, or on neither.

### `docker exec`, `curl.exe` and `dotnet run` all measure themselves

`Measure-Probe.ps1` next door reports server-side elapsed separately from its own clock
because `docker exec` plus sqlcmd start-up costs roughly 300 ms per invocation. A loop over
`curl.exe` has the same problem from the other end: process start-up dwarfs every route here,
and the whole connected table below would round to "about 300 ms" whatever the API did.

So: one process, one `HttpClient`, one connection (`MaxConnectionsPerServer = 1`), warmed.
And Release, not Debug — `dotnet run` defaults to Debug, where the JIT skips inlining, and a
measurement taken there describes a build nobody runs.

### Whatever is measured first pays for the whole pipeline

The floor route is measured first by construction, so on the first version of this script it
absorbed the JIT cost of Kestrel's HTTP/1.1 parser, the security-header middleware, the
compression middleware and the Brotli encoder. Every other route then reported a **negative
`OverFloorMs`** — observed at −0.43 ms, which is not a route being faster than doing nothing,
it is the floor being wrong.

The script now issues 20 discarded requests per encoding to `/healthz` before anything is
measured, and **re-measures the floor after the run** and reports the drift. A floor that
moved is the signal that something outside the harness did — usually a background collector
landing mid-run, which is the same thing a wide `MaxMs` is showing. Drift within ±0.2 ms is a
quiet machine.

### Auto-decompression hides the number you came for

`AutomaticDecompression` is off. It would both hide the encoded size and fold decompression
into the measured time, and the encoded body is what a client actually waits for (#84).
`Bytes` is what went on the wire; `IdentityBytes` is what the client ends up with.

### Compression can make a small response bigger

Not a subtle effect, and the table shows it plainly: `/healthz` is **20 bytes uncompressed
and 24 bytes as Brotli**, `/readyz` 18 against 22. The floor route itself costs 0.44 ms with
`Accept-Encoding: br, gzip` against 0.25 ms with `identity` — the middleware is 0.19 ms on a
body that got *larger*.

That is not an argument against the middleware, which earns its place many times over on the
routes that matter. It is an argument for always reading `Bytes` next to `IdentityBytes`,
because a compression ratio quoted from the large routes alone describes only the large
routes.

## Reading the table

| column | what it is |
| --- | --- |
| `MedianMs` | Request to last byte of the body, from this process. |
| `OverFloorMs` | `MedianMs` minus the floor route's. **This is the route's own cost.** |
| `TtfbMs` | Request to response headers. `MedianMs − TtfbMs` is body transfer and encoding. |
| `P95Ms` / `MaxMs` | Spread. A `MaxMs` well above `P95Ms` is usually a collector landing. |
| `Bytes` | What went on the wire, after `Content-Encoding`. |
| `IdentityBytes` | What the client ends up with after decoding. |

Sub-millisecond rows are at this harness's resolution: a −0.01 ms `OverFloorMs` on `/readyz`
means "does nothing, same as `/healthz`", not "faster than nothing". The rows worth quoting
are the ones in the milliseconds.

## A worked example: what the API costs, and what #94 left behind

AMD Ryzen 9 5900X, 32 GB, Windows 11, .NET 10.0.111, Release publish, SQL Server 2022 in
Docker on loopback. Rig: 4,200 objects, 5,869 queries, 5,869 plans, 14,794 runtime buckets
over 10 intervals. 25 iterations per route after 3 discarded, plus a 20-request pipeline
warm-up, from a store reset at the start.

```powershell
./Measure-Api.ps1 -ResetStore -AcceptEncoding 'br, gzip', 'identity' -Iterations 25
```

| route | median ms (br) | over floor | wire bytes | identity bytes | median ms (identity) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/healthz` | 0.44 | 0.00 | 24 | 20 | 0.25 |
| `/readyz` | 0.43 | −0.01 | 22 | 18 | 0.25 |
| `/api/v1/deployment` | 0.43 | −0.01 | 55 | 58 | 0.27 |
| `/api/v1/atlas/status` | 0.42 | −0.02 | 281 | 459 | 0.24 |
| `/api/v1/database-city` | 0.44 | 0.00 | 309 | 1,941 | 0.26 |
| `/api/v1/capabilities` | 0.70 | 0.26 | 2,128 | 28,190 | 0.32 |
| `/api/v1/atlas` | 0.74 | 0.30 | 1,652 | 14,118 | 0.31 |
| `/api/v1/query-store/status` | 3.97 | 3.53 | 302 | 542 | 3.72 |
| `/api/v1/findings/` | 4.93 | 4.49 | 1,201 | 4,604 | 7.46 |
| `/api/v1/findings/status` | 4.96 | 4.52 | 2,248 | 7,033 | 4.66 |
| `/api/v1/findings/export` | 5.90 | 5.46 | 1,273 | 4,750 | 5.34 |
| `/api/v1/query-store/queries?pageSize=50` | 10.07 | 9.63 | 4,998 | 68,307 | 5.91 |

Three things fall out of that, and none of them are visible from reading the code.

**#94 landed, and this is the evidence from the other side.** `/api/v1/findings/status`
costs **4.52 ms over floor** against the 388.59 ms that justified the change — and it is
*not* the smallest number in the table, so what remains is real and attributable rather than
noise. It sits just above `/api/v1/query-store/status` at 3.53 ms, which is what
`SourceBackedFindingsEvidenceProvider` says it should: the cached bundle costs "the one
status read needed to establish the key", and that status read is right there being measured
independently. The difference, about 1 ms, is the rules plus serialization — the same
neighbourhood as the 1.67 ms measured directly in #94, arrived at from the opposite
direction.

**Everything backed only by memory is indistinguishable from doing nothing.** `/api/v1/atlas`
serves a 14 KB snapshot for 0.30 ms over floor and `/api/v1/capabilities` a 28 KB one for
0.26 ms, and both of those are mostly the Brotli pass rather than the work. Optimising either
would be optimising a fraction of a millisecond. The cost in this API is concentrated
entirely in the routes that read the protected store, and `/api/v1/query-store/queries` is the
most expensive thing it serves.

**Compression is a decisive win on size and cheap in time.** `/api/v1/query-store/queries`
goes from 68,307 bytes to 4,998 — **13.7×** — and `/api/v1/capabilities` from 28,190 to
2,128, **13.2×**. On a 1 Mbps link the first of those is worth about 500 ms of transfer. What
it costs is harder to pin down than what it saves: the floor delta puts the middleware's fixed
overhead at **0.19 ms**, and `/api/v1/capabilities` is 0.38 ms slower with Brotli than
without, so encoding 28 KB is roughly another 0.19 ms. On the protected-store routes the
br-versus-identity difference is *smaller than the run-to-run noise* and cannot be separated
at all — which is the honest answer, and the reason those rows are not quoted as a compression
cost.

The *shape* is what generalizes. These are loopback numbers from a warm process on a quiet
desktop, so they are a floor for what a deployment does — re-measure before quoting absolute
figures anywhere they matter.

## How much to trust a single figure

Two identical runs, both `-ResetStore`, back to back, same build:

| route (br) | run A | run B | difference |
| --- | ---: | ---: | ---: |
| `/healthz` | 0.51 | 0.44 | 0.07 |
| `/api/v1/query-store/status` | 5.20 | 3.97 | 1.23 |
| `/api/v1/findings/` | 5.32 | 4.93 | 0.39 |
| `/api/v1/findings/status` | 6.53 | 4.96 | 1.57 |
| `/api/v1/query-store/queries?pageSize=50` | 10.76 | 10.07 | 0.69 |

Body sizes are reproducible to the byte (68,306 against 68,307), and the *classes* are never
in doubt — nothing that does no work ever crosses 1 ms, and nothing that reads the store ever
falls below 3 ms. But the protected-store medians move by up to 25% between runs, so a change
claiming less than that has not been demonstrated by one run of this tool. Run it three times,
or measure something bigger.

## What it deliberately does not do

- **No CI.** Same as its two siblings.
- **Loopback only.** The API is bound to `127.0.0.1` and nothing here is reachable off the
  machine.
- **Nothing in `src/` knows it exists.** No debug hook, no timing header, no test-only
  endpoint. A measurement that needed one would be measuring the hook too, and would not be
  available on the build that ships.
- **No second SQL Server.** It reuses `tools/measure/`, including the reader credential that
  rig creates.

`-Json` and `-Label` are there so two runs can be compared later without re-deriving what
each one was. The JSON carries every individual sample, not just the summary.
