# Connected SQL Server mode

Connected mode runs only the embedded, startup-validated, static read-only SQL probe catalog. It
never executes grants or tuning changes.

## Quick start: a single connection string

The fastest way to point SQLSimCity at a real server is one ordinary ADO.NET connection string:

```text
ConnectionStrings__SqlSimCity=Server=sql01.example.internal,1433;Database=master;User Id=sqlsimcity_reader;Password=...;TrustServerCertificate=true
```

`SQLSIMCITY_CONNECTION_STRING` works identically, for parity with the edge connector's naming.

Setting either one turns connected mode on by itself — Atlas, live incidents, and Query Store
history all switch off the fixture path with no `Atlas:Mode`, `LiveIncidents:Mode`, or
`QueryStoreHistory:Mode` needed. With no connection string configured, fixtures stay the default.

Query Store history retains query text and plan XML in protected storage, so it requires that store
to be configured. Rather than make you turn that on by hand, a connection string enables it for you:
the data directory is created, checked for writability, and announced at startup with a warning
naming it.

**The retained records are written in the clear.** Showing captured plans and query text is the
entire point of this tool, so the store keeps them readable — an operator can open the SQLite file
and see exactly what was collected. There is no key, no secret to mount, and nothing to rotate.

That also means the data directory is the trust boundary. Anyone who can read it can read every
retained plan and query text, including any literal parameter values a showplan carries. Mount it
with restrictive permissions and protect backups of it accordingly.

If the data directory cannot be created or written at all, Query Store history disables itself with
a warning rather than blocking startup.

To decide for yourself where retained evidence lands, set `ProtectedStorage:Enabled=true` and
`ProtectedStorage:DataDirectory` explicitly; nothing is then enabled on your behalf.
`QueryStoreHistory:Mode=Disabled` opts out of collection completely.

The connection string is parsed into exactly the same validated `ConnectionProfile` the settings
below produce, so every downstream guarantee still holds: the password is passed as a
`SqlCredential` and never appears in a connection string, log, or diagnostic; `ApplicationIntent`
is forced to `ReadOnly`; and the application name is forced to `SQLSimCity`.

**This is a convenience, not the hardened path.** A password in a connection string is readable by
anything that can read the process environment and cannot be rotated without a restart, unlike the
mounted secret files the settings path uses. The API logs a warning at startup when one is
configured. Use it for local development and evaluation; prefer the settings below in production.
See [SECURITY.md](../SECURITY.md).

What a connection string cannot express, and what SQLSimCity does about it:

| Concern | Behavior |
| --- | --- |
| Engine platform | Inferred from the host name for both connection strings and field profiles: `*.database.windows.net` is taken as Azure SQL Database, everything else as SQL Server on-premises. Override with `Atlas:Platform` and `LiveIncidents:Connection:Platform`; Managed Instance shares that suffix, so it must be stated explicitly. |
| `Atlas:KnownDatabases` | Defaults to the connection string's own `Database` when the host is Azure SQL. Explicit configuration always wins. |
| `Encrypt=false` | Rejected. SQLSimCity supports only `Mandatory` (the SqlClient default) and `Strict`. |
| Workload identity, service principal, `Active Directory Default` | Rejected. These need a tenant id a connection string cannot carry, or are banned outright; use the settings below. |
| `Connect Timeout=0` / `Command Timeout=0` | Rejected. Timeouts are bounded, never infinite. |
| `Max Pool Size` | Defaults to 20, matching the settings below, not SqlClient's own default of 100. An explicit value always wins. |
| `Server=admin:host`, `np:`, `lpc:` | Rejected. SQLSimCity rebuilds the connection string as TCP, so honoring a different protocol or endpoint is not possible; silently connecting elsewhere would be worse. `tcp:` is accepted. |

Supported authentication in a connection string: SQL login (`User Id` + `Password`), Kerberos
(`Integrated Security=true`), and managed identity
(`Authentication=Active Directory Managed Identity`, with `User Id` as the user-assigned client id).

A connection string **cannot be combined with any `Atlas:Connection` or `LiveIncidents:Connection`
field it already covers** — host, port, instance, database, timeouts, pool bounds, encryption,
certificate trust, or authentication. Configuring both is rejected at startup rather than silently
resolved in the connection string's favor, because `ConnectionStrings__SqlSimCity` is a conventional
name that some hosting platforms inject automatically: without this check, one appearing in the
environment would quietly replace a hardened profile's authentication strategy, TLS trust setting,
and mounted password file. Labels a connection string cannot express stay configurable alongside
one: `Atlas:Connection:ProfileId`, and `LiveIncidents:Connection`'s `TargetId`, `DisplayName`,
`Platform`, and `Secrets`.

A section-scoped key overrides the shared one for a single subsystem — `Atlas:ConnectionString` and
`LiveIncidents:Connection:ConnectionString`. Resolution order is section key, then
`ConnectionStrings:SqlSimCity`, then `SQLSIMCITY_CONNECTION_STRING`.

## Connection settings instead of a raw connection string

For production, SQLSimCity prefers a typed `ConnectionProfile` over a raw connection string. This
keeps passwords and access tokens out of environment variables, logs, and process arguments
entirely: only a *reference* to a mounted secret file is configured, and the bytes are read from
that file at use time.

The Atlas profile is configured under `Atlas:Connection`:

| Setting | Purpose |
| --- | --- |
| `Host` | SQL Server DNS name or IPv4 address reachable from the container |
| `Port` | TCP port; mutually exclusive with `Instance` |
| `Instance` | Named instance; mutually exclusive with `Port` |
| `InitialDatabase` | Initial database, usually `master` for SQL Server/Managed Instance |
| `ConnectTimeoutSeconds` / `CommandTimeoutSeconds` | Bounded connection and probe timeouts |
| `MaxPoolSize` | Bounded SqlClient pool |
| `Encryption` | `Mandatory` or `Strict` |
| `HostNameInCertificate` | Optional expected TLS certificate name |
| `TrustServerCertificate` | Explicit per-profile opt-in; rejected with `Strict` |

The corresponding environment variable replaces `:` with `__`, for example:

```text
Atlas__Connection__Host=sql01.example.internal
Atlas__Connection__Port=1433
Atlas__Connection__InitialDatabase=master
```

`Atlas:Platform` optionally selects `SqlServerOnPremises`, `AzureSqlDatabase`, or
`AzureSqlManagedInstance` for Atlas, Query Store history, and capability probe routing.
For an Azure SQL private alias that does not use the public hostname suffix, explicitly set
`Atlas__Platform=AzureSqlDatabase` and the contained `InitialDatabase`. For Managed Instance use
`Atlas__Platform=AzureSqlManagedInstance`. The setting controls routing, not evidence: the
capability negotiator still reads the actual engine identity, permissions, and metadata.

## Compose override

Keep the default [`compose.yaml`](../compose.yaml) and add a local
`compose.connected.yaml` (do not commit real secret files):

```yaml
services:
  sqlsimcity:
    environment:
      # Development shortcut -- one variable, no mounted secret file. The password
      # is readable from the container environment; see the quick start above.
      # ConnectionStrings__SqlSimCity: "Server=sql01.example.internal,1433;Database=master;User Id=sqlsimcity_reader;Password=...;TrustServerCertificate=true"
      Atlas__Mode: Connected
      Atlas__TargetId: production-east
      Atlas__DisplayName: Production East
      Atlas__Connection__Host: sql01.example.internal
      Atlas__Connection__Port: "1433"
      Atlas__Connection__InitialDatabase: master
      Atlas__Connection__Encryption: Mandatory
      Atlas__Connection__Authentication__Mode: SqlLogin
      Atlas__Connection__Authentication__Username: sqlsimcity_reader
      Atlas__Connection__Authentication__PasswordSecret: sql-password
      Atlas__SecretsDirectory: /run/secrets

      # Retained Query Store history requires protected storage. Setting
      # ProtectedStorage__Enabled explicitly keeps the choice of where retained
      # evidence lands in your hands. (Drive the connection from a connection
      # string instead and this is turned on for you.)
      QueryStoreHistory__Mode: Connected
      ProtectedStorage__Enabled: "true"
      ProtectedStorage__DataDirectory: /data

      # Live sampling has its own cadence/profile and must name the same target
      # when its counts should appear in the Atlas.
      LiveIncidents__Mode: Connected
      LiveIncidents__Connection__TargetId: production-east
      LiveIncidents__Connection__DisplayName: Production East
      LiveIncidents__Connection__Platform: SqlServerOnPremises
      LiveIncidents__Connection__Server__Host: sql01.example.internal
      LiveIncidents__Connection__Server__Port: "1433"
      LiveIncidents__Connection__Database: master
      LiveIncidents__Connection__Encryption: Mandatory
      LiveIncidents__Connection__Authentication__Mode: SqlLogin
      LiveIncidents__Connection__Authentication__Username: sqlsimcity_reader
      LiveIncidents__Connection__Authentication__PasswordSecretFile: sql-password
      LiveIncidents__Connection__Secrets__Directory: /run/secrets
    secrets:
      - sql-password

secrets:
  sql-password:
    file: ./secrets/sql-password
```

Run:

```powershell
docker compose -f compose.yaml -f compose.connected.yaml up --build
```

The protected-storage key-ring format, generation commands, rotation rules, and backup requirements
are documented in [`SECURITY.md`](../SECURITY.md).

## Authentication modes

Exactly one strategy is selected. Authentication never falls back to another strategy.

| Mode | Required settings |
| --- | --- |
| `SqlLogin` | username plus password secret-file reference |
| `Kerberos` | Linux service identity/keytab configured outside the connection string |
| `ManagedIdentity` | optional user-assigned client ID |
| `WorkloadIdentity` | tenant ID, client ID, projected federated-token file |
| `ServicePrincipalCertificate` | tenant/client IDs plus certificate and optional password secret files |
| `ServicePrincipalSecret` | tenant/client IDs plus client-secret file |

SQLSimCity never uses `DefaultAzureCredential` or an interactive credential chain. See
[`SECURITY.md`](../SECURITY.md) for Kerberos SPN/DNS/clock requirements, Microsoft Entra endpoints,
IMDS, certificate handling, and credential rotation.

## Azure SQL Database

Azure SQL Database is database-scoped:

- set `Atlas__Connection__InitialDatabase` to a user database;
- set `LiveIncidents__Connection__Platform=AzureSqlDatabase`;
- list every collected database explicitly:

```text
Atlas__KnownDatabases__0=sales
Atlas__KnownDatabases__1=warehouse
```

SQLSimCity does not assume logical-server-wide visibility, connect to `tempdb`, or treat Azure
database IDs as globally unique.

## Least-privilege permissions

The exact required visibility depends on platform, version, service tier, and enabled surfaces.
SQLSimCity reports missing permission as evidence and never grants it.

Typical SQL Server grants:

- SQL Server 2016-2019: `VIEW SERVER STATE` plus `VIEW DATABASE STATE` in collected databases.
- SQL Server 2022+: `VIEW SERVER PERFORMANCE STATE` plus `VIEW DATABASE PERFORMANCE STATE`.
- `CONNECT` to every collected database.
- Keep `VIEW ANY DATABASE` only when automatic database discovery is desired.

Azure SQL Database should use the smallest documented database-scoped permission or role supported
by its service tier. Review the per-probe permission and platform notes in
[`sql/README.md`](../sql/README.md) before deploying a production principal.

## Connected subsystems

### Atlas and database city

`Atlas__Mode=Connected` discovers at most 100 databases (except explicit Azure lists), collects
capacity, Query Store summaries, and file-I/O counters with bounded concurrency, and never overlaps
refresh cycles. Database-city object/index pages are queried only when entered.

### Query Store history

Connected Query Store history is enabled by a connection string, or explicitly with
`QueryStoreHistory__Mode=Connected`. Either way it requires Atlas connected mode and protected
storage, which a connection string enables automatically (see the quick start above). The
collector uses keyset pages, overlap watermarks, reset epochs, active-interval replacement, bounded
generations, and a final publication pointer.

Raw SQL and Showplan XML are fetched only on demand and stored as detail records. Normalized facts,
per-interval detail and hourly history all follow the same retention horizon, 24 hours by default
and configurable — see below.

Those on-demand payloads are a cache, and `QueryStoreHistory__PlanCacheQuotaBytes` bounds it —
2 GiB by default, which is roughly 45,000 distinct plans at the ~45 KB one hydrated plan cost when
this was measured. Past the quota, the oldest entries are evicted whole and re-read from the
server the next time they are asked for; nothing else in the store is touched. Set it to `0` for
no bound, in which case seven-day retention is the only one — and retention prunes at most 500
records per collection cycle, which a crawl outruns comfortably.

Both figures an operator needs are logged. Every publish reports the families, records, bytes and
storage write-lock hold it cost (`QueryStorePublishCost`); every few cycles the store reports its
record count, stored bytes, on-disk bytes and how much of that is the plan cache
(`ProtectedStorageUsage`), and warns when the expired-record backlog is beyond what one prune per
cycle can clear (`ProtectedStoragePruneBacklog`). A publish rewrites the whole generation rather
than the part that changed, so the publish figure is the write churn per cycle, not a delta; and
the previous generation stays on disk until its slot is reused, so retained snapshot bytes are
about twice one publish.

The first cycle for a database has no watermark to resume from, so it looks back
`QueryStoreHistory__InitialLookbackMinutes` (one backfill increment by default, never narrower than
the re-read overlap) rather than to the
server's oldest retained interval. A source retaining more than that would otherwise be read in full
on first connection, for evidence the first prune discards. When the source holds less than the
lookback, its own boundary wins. The lookback cannot exceed the retention horizon, and the published
`oldestAvailableAt` reports what was actually collected and retained, never the server's older
boundary.

How much history is kept is itself configurable. `QueryStoreHistory__RetentionHours` (**24** by
default, one hour at least and 365 days at most) sets the horizon normalized facts and hourly
rollups survive, and `QueryStoreHistory__DetailRetentionHours` sets how much of that keeps
per-interval runtime detail before it is rolled up hourly; unset it is one day, or the retention
horizon when that is shorter, and it can never exceed it. Both the sink's prune and the collector's
caps read the same figure, so lowering retention lowers what is read and what is stored in one step
rather than leaving the collector gathering evidence the prune then discards.

A day rather than a quarter-year because this is a picture of a city's *current* traffic. Ninety
days of accumulated executions grade every street by a quarter-year average, which is the one thing
a traffic map must not do: a road that was slow in May reads slow today, and a road that went bad an
hour ago is diluted to nothing by the calm behind it. Raise it if you want the query history to
reach further back — `RetentionHours: 2160` is the ninety days that shipped before v1.0.0 — knowing
that every publish rewrites the whole slot, so retention sets the steady-state write churn per
cycle as well as the disk footprint.

Street colour is graded from a separate, shorter window: `DatabaseCity__TrafficWindowMinutes`,
15 by default. Retention decides which streets exist at all; this decides what colour they are.
Widen it to see anything on a quiet instance, narrow it so a spike on a busy one stops colouring the
map long after it ended.

History older than the lookback still arrives, an increment at a time. Each cycle reads its ordinary
forward window and one further step backwards of `QueryStoreHistory__BackfillIncrementMinutes`
(**60** by default), so the first cycle stays cheap and depth arrives over the cycles that follow.
This matters most after the data volume is recreated: watermarks live in protected storage, so
losing that volume loses the resume point too, and a publish is atomic — nothing appears in the
query views until the first cycle completes, which is how a deployment with a large Query Store can
look stalled while it is in fact still reading. Progressive backfill is what keeps that first cycle
from becoming one unbounded read. Set the increment to zero to switch the walk off entirely.

The walk stops at `QueryStoreHistory__BackfillHorizonHours`, **3** by default and capped at the
retention horizon: reading past what the store keeps would re-create the waste the lookback
cap removed. It also stops at the server's own oldest retained interval, whichever is later. How far
it has actually reached is persisted per database as a second, low watermark, so a run interrupted
part-way resumes from there rather than starting the walk again; a reset restarts it along with the
epoch. Pick an increment larger than the ground the horizon covers between cycles, or the floor
slides forward as fast as the walk moves back and the backfill never finishes.

### Settings retired in v1.0.0

The retention and backfill settings changed unit when the collector stopped archiving and started
following current traffic, so the old names are **refused at startup** rather than ignored —
`BackfillHorizonDays: 3` and `BackfillHorizonHours: 3` differ by a factor of 24, and a setting that
silently stopped being read would leave a deployment running against a horizon nobody chose. Each
retired key names its replacement in the error.

| retired | replacement |
|---|---|
| `QueryStoreHistory__RetentionDays` | `QueryStoreHistory__RetentionHours` |
| `QueryStoreHistory__DetailRetentionDays` | `QueryStoreHistory__DetailRetentionHours` |
| `QueryStoreHistory__InitialLookbackDays` | `QueryStoreHistory__InitialLookbackMinutes` |
| `QueryStoreHistory__BackfillIncrementHours` | `QueryStoreHistory__BackfillIncrementMinutes` |
| `QueryStoreHistory__BackfillHorizonDays` | `QueryStoreHistory__BackfillHorizonHours` |

A deployment that set none of them needs no configuration change to upgrade. It will keep one day of
history instead of ninety, and the first prune after the upgrade discards what falls outside that.

`oldestAvailableAt` is unaffected by any of this. It is derived from the runtime buckets actually
being published, so it follows collected and retained history as the low watermark moves, and stays
`null` while nothing has been collected rather than reporting where the backfill intends to reach.

Collection needs Query Store to be enabled on the databases themselves (`ALTER DATABASE ... SET
QUERY_STORE = ON`); databases with it off are discovered and skipped.

The system databases `master`, `tempdb`, `model`, and `msdb` are excluded from Query Store
entirely. Query Store cannot be enabled on `master` or `tempdb` at all, and the engine's own
maintenance workload in `msdb` or the `model` template is not application evidence. They are never
collected (naming one in `Atlas__KnownDatabases` collects nothing from it), their atlas record
reports Query Store as `Unsupported` rather than as a failed component, so they never make a
collection cycle report as degraded, and the `query-store-health` finding is never raised against
them. They still appear in the atlas with their capacity, live activity, and file-I/O evidence.

### Live incidents

Live incidents use an independent profile because their sampling cadence, initial database, and
platform scope can differ from historical collection. Give it the same `TargetId` as Atlas to project
fresh live counts into the database atlas.

Sampling is not a trace: a request or blocking chain that begins and ends between polls can be missed.
Every result carries source/freshness timestamps and explicit stale, disconnected, permission-denied,
or unsupported states.

#### Sample bounds

A snapshot's size is set by the watched instance, not by SqlSimCity: session count is bounded only by
the server's connection limit, and batch text by whatever a client submits. Both are collected and
serialized in full on every cycle and then broadcast whole to every connected client, so
`LiveIncidents:SampleBounds` bounds them.

| key | default | effect |
|---|---:|---|
| `MaxRequestRows` | `1000` | Session/request rows per snapshot. Kept active-requests-first, then longest-running, then by session id. |
| `MaxTextLength` | `16384` | Characters of batch text, and of executing-statement text, per row. |
| `MaxTempdbRows` | `1000` | tempdb session rows and task rows per snapshot. Kept heaviest-allocator-first. |

Set any of them to `0` to remove that bound and restore the unbounded behaviour. A negative value is
rejected at startup rather than guessed at.

**Nothing a bound omits is omitted silently.** A capped snapshot reports the pre-cap counts in
`diagnostics.truncations`, and a shortened value reports its untruncated length in the row's
`batchTextTruncation` / `currentStatementTextTruncation`. So "5,009 sessions, showing 1,000" stays
distinguishable from "1,000 sessions", and 16,384 characters of a 1,048,576-character batch from a
16,384-character batch. A row that was cut by the row cap is never reported as having *disappeared*
either, because a capped sample is no evidence that the request ended.

Raising `MaxTextLength` is a real trade rather than a free one — collection cost grows faster than
linearly in it, because the text has to be materialized out of the engine before anything can shorten
it. Measured against SQL Server 2022 with 250 concurrent requests each executing a 64 KiB
single-statement batch:

| `MaxTextLength` | snapshot | collect | allocated per cycle |
|---|---:|---:|---:|
| 4096 | 2.6 MiB | 68 ms | 15 MiB |
| 16384 (default) | 8.4 MiB | 149 ms | 99 MiB |
| 65536 | 31.9 MiB | 457 ms | 1158 MiB |
| `0` (no bound) | 31.7 MiB | 487 ms | 2183 MiB |

That is per cycle, every 2–5 seconds. Reproduce with `tools/measure/`.

## TLS and reverse proxies

- `Mandatory` requires encrypted transport and supports an explicit per-profile
  `TrustServerCertificate` opt-in.
- `Strict` uses strict TLS and rejects `TrustServerCertificate=true`.
- Behind an authenticating reverse proxy, configure `AllowedHosts` to the exact externally accepted
  host names. Forwarded headers are ignored unless you name the trusted proxy under `ReverseProxy`;
  see [`docs/operations.md`](operations.md#forwarded-client-addresses).
- Keep the backend network path private even when the proxy provides TLS and authentication.

See [`docs/operations.md`](operations.md) for complete deployment, upgrade, rollback, and recovery
guidance.
