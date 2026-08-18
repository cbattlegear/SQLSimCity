# Changelog

All notable changes to SQLSimCity are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

SQLSimCity is independent software and is not affiliated with, sponsored by, or
endorsed by Microsoft, Electronic Arts, Maxis, or the SimCity franchise. No
SimCity assets are included.

## [Unreleased]

First MVP release candidate. There is no tagged release yet.

### Added

- **Single connection string configuration** for every connected surface. One ordinary ADO.NET
  connection string can now stand in for the ~15 individual connection settings plus a mounted
  password file: `ConnectionStrings:SqlSimCity` (settable as `ConnectionStrings__SqlSimCity`),
  `SQLSIMCITY_CONNECTION_STRING`, or a section-scoped `Atlas:ConnectionString` /
  `LiveIncidents:Connection:ConnectionString`, plus `SQLSIMCITY_EDGE_SQL_CONNECTION_STRING` for the
  edge connector. Supplying one turns connected Atlas and live incidents on by itself, so no mode
  setting is also required; with none configured, fixtures remain the default. The string is parsed
  into exactly the same immutable, fully validated `ConnectionProfile` the field-by-field path
  produces and is then discarded, so every existing guarantee holds — the password is delivered as a
  `SqlCredential` and never concatenated into a connection string, log, or exception;
  `ApplicationIntent=ReadOnly` and the `SQLSimCity` application name are still forced; `Encrypt=false`
  and infinite timeouts are still rejected; and only SQL login, Kerberos, and managed identity are
  accepted (workload identity and service principal need a tenant id a connection string cannot
  carry, and `Active Directory Default` remains banned). The engine platform is inferred from the host
  name (`*.database.windows.net` means Azure SQL Database), Azure SQL `KnownDatabases` defaults to the
  connection string's own database, and explicit configuration always wins over both. This is a
  documented convenience, not the hardened path: an inline password is readable from the process
  environment and cannot be rotated without a restart, so both the API and the connector log a
  warning at startup when one is in use, and mounted secret files remain the production default.
  Neither surface will combine a connection string with any field it already covers, rather than
  letting one silently win — a real safeguard, since `ConnectionStrings__SqlSimCity` is a name some
  hosting platforms inject automatically and would otherwise silently downgrade a hardened profile's
  authentication, TLS trust, and mounted password file. `Max Pool Size` defaults to 20 (the field
  path's ceiling) rather than SqlClient's 100, and `admin:`, `np:`, and `lpc:` data-source prefixes
  are rejected rather than stripped, since the profile is always rebuilt as TCP. The connector's
  prohibition on plaintext secret environment variables is unchanged.
  See `SECURITY.md`, `docs/connected-mode.md`, and `docs/edge-connector.md`.
- Outward-only **edge connector** for monitoring SQL Servers the central container cannot reach
  (`src/SqlSimCity.Edge`, `src/SqlSimCity.Edge.Connector`, `Dockerfile.connector`,
  `compose.edge.yaml`, `docs/edge-connector.md`). A connector near SQL Server connects outward over
  HTTPS, forwards the same source-neutral observations in a versioned envelope
  (`ObservationEnvelopeV1`), signs each request with HMAC-SHA-256 (constant-time verification, bounded
  clock skew, connector allowlist, key rotation, and durable replay-nonce protection), and buffers a
  bounded AES-256-GCM-encrypted spool when the central server is unavailable. Central ingestion is
  opt-in and disabled by default (`Acquisition:Mode=Edge` plus `EdgeIngestion:Enabled`); when enabled it adds one bounded
  `POST /api/v1/edge/ingest` plus read-only `GET /api/v1/edge/status`/`/targets` endpoints, validates
  schema/digest/signature/sequence/epoch/standard-payload contracts with atomic publication, bounded
  idempotency indexes, a dedicated per-client edge rate limit, and compression-bomb guards. One complete,
  allowlisted target generation projects through the existing Atlas, capabilities, Query Store,
  database-city, live, and findings APIs; partial next generations remain invisible. The UI shows a
  compact Edge source/status/target panel and labels live evidence as a static point-in-time sample.
  The connector supports fixture and opt-in connected sources; connected mode composes the production
  SQL collectors over one validated file-secret profile, bounded volatile Query Store storage, and
  text-disabled live probes. No live SQL target was validated; connected tests use fake executors.
- Fixture-mode and opt-in read-only connected server **atlas** (`/api/v1/atlas`,
  `/api/v1/atlas/status`) with a three.js scene backed by a keyboard- and
  screen-reader-accessible database evidence table.
- **Database-city semantic zoom** (`/api/v1/database-city`, `/api/v1/database-city/{databaseId}`)
  with exact page geometry, separated direct-DMV and Query-Store-attributed heat,
  and confidence-graded co-reference routes.
- **Live-incident** point-in-time DMV sampling (`/api/v1/live`) and a
  `/hubs/current-snapshot` SignalR hub, with explicit freshness/staleness and
  never-numeric-zero unavailable states.
- Encrypted, paged **Query Store history** (`/api/v1/query-store/*`) with plan
  history, a hardened Showplan parser (DTD/resolver prohibited, bounded), and
  structural plan comparison from sanitized fixtures.
- Evidence-backed **findings** engine and read-only API (`/api/v1/findings/*`)
  with redacted export.
- Source-neutral SQL Server connection library with SQL/Kerberos/Microsoft Entra
  authentication and file-referenced secrets.
- Optional AES-256-GCM encrypted SQLite record store (disabled by default) with
  fail-closed initialization, key rotation, and bounded retention/pruning.
- Versioned static, read-only SQL probe catalog (`sql/manifest.json` + `sql/probes/*.sql`).
- HTTP hardening: `AllowedHosts` pinning, strict CSP and security headers,
  64-KiB request-body bounds, and per-client API rate limiting that excludes the
  long-lived SignalR hub.
- Container hardening (non-root, dropped capabilities, read-only rootfs,
  `no-new-privileges`, loopback binding), locked dependencies, CI/release
  workflows with SBOM and provenance attestation, Docker fixture smoke, and
  backup/restore tooling with operations documentation.

### Changed

- NuGet dependencies updated, including three major bumps:
  `Microsoft.SqlServer.TransactSql.ScriptDom` 170.191.0 → 180.78.1,
  `xunit.runner.visualstudio` 3.1.5 → 4.0.0, and `coverlet.collector` 6.0.4 → 10.0.1, alongside
  `Microsoft.AspNetCore.Mvc.Testing` and `Microsoft.AspNetCore.SignalR.Client` 10.0.4 → 10.0.11 and
  `Microsoft.NET.Test.Sdk` 18.3.0 → 18.9.0. The ScriptDom bump moves the T-SQL parser from the
  SQL Server 2022 grammar to 2025; all 280 `SqlSimCity.SqlServer.Tests` parser assertions still hold.
  Because the repository pins transitive versions with `RestorePackagesWithLockFile`, all 13 affected
  `packages.lock.json` files were regenerated with `dotnet restore --force-evaluate`; without that
  step CI's `dotnet restore --locked-mode` fails with `NU1004`, which is why the equivalent
  automated dependency pull requests could not build.
- Frontend build is code-split: the three.js atlas/city viewports and the Query
  Store, Live, and Findings tabs load as lazy chunks, and three.js is isolated
  into its own vendor chunk. The initial-path bundle drops from ~848 KiB to
  ~220 KiB and three.js is no longer on the first-paint critical path.
- The Query Store `database_workload_summary` probes now bound the runtime-stats
  interval join by overlap (`end_time > @StartTime AND start_time < @EndTime`),
  matching `runtime_stats_summary` and `wait_stats_summary`, so the atlas
  database-wide totals reconcile with the per-plan drill-down over the same window.

### Fixed

- `LiveIncidentSampler` no longer throws `ObjectDisposedException` when a stop races disposal. The
  disposed check at the top of `StopAsync` is a check-then-act, so a caller could pass it and then be
  preempted before awaiting the control lock that `DisposeAsync` had already disposed. Host shutdown
  makes exactly that interleaving routine, because `IHostedService.StopAsync` and container disposal
  run back to back and `StopAsync(TimeSpan)` can abandon a stop that is still running. The semaphore
  is now left to the GC, which is safe because its `AvailableWaitHandle` is never touched. In CI this
  surfaced as an intermittent "Test Class Cleanup Failure" that failed the build while every
  individual test still reported as passing.
- Rejected edge batches no longer create phantom targets, reserve ownership, mutate partial groups,
  advance generation state, or consume idempotency entries; both accepted-batch indexes now evict
  coherently at a deterministic bound.
- The local Edge Compose example now uses a genuinely loopback HTTP connection by sharing the central
  service network namespace; production delivery remains HTTPS-only.
- Both runtime images now declare the repository's Apache-2.0 license and contain `LICENSE`/`NOTICE`.
- A rejected lazy-chunk import no longer unmounts the application: every lazy
  surface is wrapped in an error boundary that renders a focused, announced
  alert with a reload action.
- Connected live-incident sampling no longer fails on every cycle. The transaction-log probe
  emits exact `total_log_size_bytes`/`used_log_space_bytes`, but the live-incident executor read
  `total_log_size_mb`/`used_log_space_mb`, so every sample threw `IndexOutOfRangeException` against
  a real server. It now reads the byte columns and converts to the megabytes the contract, findings
  rule, and UI all expect. This was invisible to the unit tests, which substitute a fake probe
  executor for the real `SqlDataReader` path, so a corpus-wide guard now asserts that every column
  the Atlas and live-incident executors read by name is actually emitted somewhere in the probe SQL.
- Connected live-incident sampling no longer fails on every cycle **against Azure SQL Database**.
  `SERVERPROPERTY('IsHadrEnabled')` is documented "Applies to: SQL Server", and SERVERPROPERTY
  returns NULL for any property unsupported on the connected engine, so the server-identity probe
  returned NULL there and the unguarded `Convert.ToInt32` threw
  `InvalidCastException: Object cannot be cast from DBNull to other types` on every sample. Azure
  SQL Database and Managed Instance now read as "not enabled", which is what the value means on a
  platform whose high availability is built in rather than configured as an availability group.
  The same unguarded read was present in the edge connector's probe executor and is fixed with the
  shared helper.
- A single unreadable column no longer costs an entire live-incident cycle. `LiveIncidentCollector`
  is designed to degrade — it records an `UnavailableFieldV1` and publishes the rest of the
  snapshot — but only recognized `ProbeExecutionException`s, so a row-projection failure escaped to
  the sampler and destroyed every other subsystem's evidence for that cycle. Row-shape failures are
  now classified as the already-defined `ProbeDataFormatException`, so an unexpected NULL or missing
  column on any engine edition degrades exactly one field, names itself in
  `diagnostics.unavailableFields`, and leaves the rest of the snapshot intact. Genuine programming
  faults are deliberately still allowed to propagate.
- Connected Query Store history now collects. `SqlQueryStoreIncrementalSource` issued every probe
  with `CommandBehavior.SequentialAccess`, which permits each column to be read once and only in
  ascending ordinal order, while all nine of its projectors read columns by name in whatever order
  the record needs. Database discovery read `is_query_store_on` (ordinal 8) before `database_name`
  (ordinal 1), so the very first step of every cycle threw
  `InvalidOperationException: Invalid attempt to read from column ordinal '1'` and connected Query
  Store history had never collected a single row against a real server. Nothing in that file uses a
  streaming accessor, so sequential access bought no memory saving and only made by-name projection
  illegal; it now uses the default behavior, matching the Atlas, live-incident, and connector
  executors. A corpus-wide guard asserts no probe reader combines by-name column access with
  `SequentialAccess`.
- Supplying a connection string no longer produces query views that are emptier than the sample
  data. Connected Query Store history requires encryption at rest and has no plaintext fallback, but
  a connection string enabled Atlas and live incidents while leaving Query Store history on
  `UnavailableQueryStoreHistorySource`, so pointing SQLSimCity at a real server silently downgraded
  the query views to nothing at all — with no error and no log line. A connection string now enables
  connected Query Store history and provisions the required AES-256 key, so the encryption
  requirement is met rather than relaxed.

### Security

- A connection string now auto-provisions the protected-storage AES-256 key that connected Query
  Store history requires, in a `sqlsimcity-keys` directory inside the data directory. Encryption at
  rest is unchanged and still mandatory; what changes is that the process generates the key instead
  of an operator supplying it, so key custody is weaker than the hardened path. It is placed inside
  the data directory deliberately, so the key is exactly as durable as the data it protects: in a
  container every other location is either unwritable or ephemeral, and a key destroyed while its
  data survives leaves every protected record permanently unopenable. The trade-off is that a raw
  volume snapshot contains both. It is written `0600`, never overwrites an existing key, and is
  announced at startup with a warning naming the path. The hardened path is untouched: setting
  `ProtectedStorage:Enabled=true`, or configuring the connection field by field, still means
  operator-supplied key custody and still fails closed without a key. Auto-provisioning never
  happens in archive or edge mode, and never overwrites a mounted key.
- `tools/backup-data.sh` now excludes the storage key from the archive instead of refusing to run
  when the key resolves inside the data directory, and verifies the key is genuinely absent before
  writing the backup. The guarantee that no backup carries its own decryption key is preserved;
  what changes is that deployments using an auto-provisioned key can be backed up at all. A hard
  link to the key inside the data directory is still refused, because it cannot be excluded by path.
  **A backup therefore cannot restore a protected store on its own — the key must be kept
  separately.**
- A key that cannot be written no longer takes the process down. Where the data directory is not
  writable, connected Query Store history disables itself with a warning explaining the cause and
  the fix, preserving the previous startup behavior instead of turning a convenience into an outage.
- A persistent, color-independent trusted-network / no-built-in-login notice is
  now shown on every analysis view, including on mobile, reinforcing the
  documented `AllowedHosts` and reverse-proxy guidance.

### Known limitations

- **Live SQL Server validation is partial.** Connected Atlas collection, live-incident sampling, and
  connected Query Store history have now been exercised end to end against a real local SQL Server
  (Kerberos/integrated auth), which is what surfaced the transaction-log column defect and the
  `SequentialAccess` defect above. Query Store history was confirmed collecting real queries with
  real runtime metrics from a live database. The Azure SQL Database
  `IsHadrEnabled` defect above was reported from a real Azure SQL Database and was reproduced and
  verified locally by making the identity probe emit NULL for that column, but no Azure SQL Database
  or Managed Instance target was available for direct end-to-end confirmation, so platform-specific
  behavior on those, and every Entra authentication strategy, remains otherwise exercised only
  against fakes and deterministic fixtures. Query Store collection past database discovery has been
  observed only against a single local server, so engine-version-specific projectors (the 2016/2022
  variant and 2025 replica paths in particular) are still unproven on the editions that select them.
- GHCR image publication, SBOM, and provenance attestation are defined in the
  release workflow but are not executed as part of this candidate; their outputs
  are unverified until a tagged release runs.
- Behind a reverse proxy, forwarded-header processing is intentionally disabled,
  so API rate-limit partitioning collapses all clients into one bucket. This is
  correct for the documented loopback/trusted-network model.
