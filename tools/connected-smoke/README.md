# Disposable connected smoke

This Node 24 harness creates a **new SQL Server 2022 Developer container**, seeds
`SmokeCity`, starts an **already-built** SQLSimCity image, waits for real city
objects/query families, and invokes the existing Playwright harness. No npm
dependencies are added here. Docker must run Linux containers and have enough
memory for SQL Server (at least 2 GB available; allow more for the API/browser).

```powershell
# Once, using the existing browser stack:
Push-Location tools\measure-browser
npm ci
npx playwright install chromium
Pop-Location

node tools\connected-smoke\run.mjs --image sqlsimcity-ci:my-build --out artifacts\connected-smoke
node --test tools\connected-smoke\run.test.mjs
```

Use a fresh output directory for each invocation. The app image must already
exist locally; the Microsoft SQL image is pulled by Docker if missing. CI uses
its existing container-job build and installs Chromium with `--with-deps`.

## Readiness and handoff

`readiness.json` is written (and emitted as one JSON stdout line) **before** the
browser starts. It contains `origin`, `database`, the atlas-qualified city
`databaseId`, `queryStoreDatabaseId` (the SQL database name), nonsecret resource
names/run ID, SQL verification counts, API continuation evidence, and an exact `cleanupCommand`.
`result.json` records pass/fail, the failing stage, and whether resources remain.
Readiness is historical evidence after cleanup, not a claim that the origin is
still running: check `result.retained` and `result.cleanup`. Browser diagnostics use the same output
directory. Failed runs also collect bounded, credential-redacted container logs.

```powershell
# Explicitly leave a verified rig for another process to use:
node tools\connected-smoke\run.mjs --image sqlsimcity-ci:my-build --out artifacts\handoff --keep --no-browser
$rig = Get-Content artifacts\handoff\readiness.json | ConvertFrom-Json
node tools\measure-browser\smoke.js --origin $rig.origin --database SmokeCity --out artifacts\handoff

# The run-specific equivalent is also in readiness.json:
node tools\connected-smoke\cleanup.mjs --run-id $rig.resources.runId
```

Without `--keep`, `--no-browser` verifies readiness and immediately cleans up;
it does **not** leave a background server. `--keep` retains only a ready rig
(including when the subsequent browser fails); SQL/API startup failures and
SIGINT/SIGTERM always clean up. Cleanup is repeatable and verifies the exact
name **and** random ownership label before deleting by immutable resource ID.
No prune, blanket container stop, existing database drop, or shared-target
connection argument exists. SIGKILL, machine shutdown, or an unavailable Docker
daemon cannot be handled by JavaScript: use the cleanup command/run ID from
`run.json` if startup was interrupted before readiness.

### Owned-fixture SQL and API restart

For recovery acceptance, create your **own** retained rig. Do not change Query
Store state or reseed a rig somebody else is using for layout measurements.
The following reads only nonsecret ownership metadata and uses SQL's existing
password inside its container; no password is returned to the host.

```powershell
$rig = Get-Content artifacts\handoff\readiness.json | ConvertFrom-Json
$owned = docker inspect --format '{{index .Config.Labels "io.sqlsimcity.connected-smoke"}}|{{.Id}}' $rig.resources.sql
if ($LASTEXITCODE -ne 0) { throw 'SQL container is unavailable' }
$label, $sqlId = $owned -split '\|'
if ($label -ne $rig.resources.runId -or $sqlId -notmatch '^[a-f0-9]{64}$') {
    throw 'SQL ownership mismatch'
}
@'
SELECT actual_state_desc, desired_state_desc FROM sys.database_query_store_options;
GO
'@ | docker exec -i $sqlId bash -lc 'export SQLCMDPASSWORD="$MSSQL_SA_PASSWORD"; exec /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -d SmokeCity -C -b'
if ($LASTEXITCODE -ne 0) { throw 'Owned-fixture SQL failed' }
```

Replace only the SQL stdin when exercising Query Store disable/recovery on that
owned fixture. This administrative connection is separate from the read-only
collector whose permissions the runner verifies.

The API runs as the image's nonroot user. Its default protected-history database
is `/data/protected-storage.db` in its writable container layer: `docker restart`
preserves it, while cleanup/removal deliberately deletes it. This is restart
coverage, **not** recreation/volume-durability coverage. Docker can assign a
different random API port on restart; `readiness.json` records the initial one.
After verifying the API's ownership label in the same way, restart by immutable ID
and get the new port without dumping container environment variables:

```powershell
$owned = docker inspect --format '{{index .Config.Labels "io.sqlsimcity.connected-smoke"}}|{{.Id}}' $rig.resources.api
if ($LASTEXITCODE -ne 0) { throw 'API container is unavailable' }
$label, $apiId = $owned -split '\|'
if ($label -ne $rig.resources.runId -or $apiId -notmatch '^[a-f0-9]{64}$') {
    throw 'API ownership mismatch'
}
docker restart $apiId
if ($LASTEXITCODE -ne 0) { throw 'Owned API restart failed' }
$ports = docker inspect --format '{{json .NetworkSettings.Ports}}' $apiId | ConvertFrom-Json
$origin = 'http://127.0.0.1:' + $ports.'8080/tcp'[0].HostPort
# Wait for $origin/healthz, then inspect the scoped Query Store API again.
```

## Isolation and credentials

Every run has a cryptographically random network/container identity. Its bridge
network contains only its SQL/API pair, SQL has **no published port**, and only the API gets a randomly
assigned `127.0.0.1` port. No host mounts or named volumes are used. Container
removal includes any anonymous volumes created by an image.
Supplied and downloaded images stay in Docker's cache; cleanup never prunes images.
The bridge is not Docker `--internal`: Docker 29 suppresses published ports on
internal networks. Outbound networking is therefore not blocked by this harness.

Two random passwords exist only in the orchestrator's memory, Docker's
environment/configuration, and the disposable services. They are passed via
inherited environment variables and sqlcmd stdin, not command arguments, source
files, or artifacts. Docker administrators can inspect container environment
variables; `--keep` deliberately extends that lifetime. Never upload Docker
inspect output or environment dumps. SQL's `sa` is used only for creating the
disposable database/workload; the API connects as `smoke_collector`.

The collector has no `sysadmin`, `db_owner`, or database-role membership, no user
table SELECT, and explicit DML/DDL/EXECUTE denies. Its grants are server
`VIEW SERVER PERFORMANCE STATE` and database `CONNECT`, `VIEW DATABASE
PERFORMANCE STATE`, `VIEW DEFINITION`, `VIEW SECURITY DEFINITION`. The verification
connects **as that login**, checks its role/control privileges, requires a real
INSERT to fail with permission error 229, and reads Query Store plus partition
metadata. Limited data permissions may intentionally leave statistics-property
details unavailable; they must not prevent city objects or Query Store evidence.

The deterministic seed has 12 populated indexed tables in three schemas (6,240
rows), at least 163 parameterized query shapes including 139 multi-table joins,
and at least 12,905 executions. Of those, 128 join statements each run 100 times
and have distinct projection aliases that survive SQL text normalization. The
bounded repetition keeps collector probes from immediately displacing application
queries in the city's top families; every weighted family is itself a join so
the continuation seed does not displace the routes either. Readiness walks
the real Query Store API's first 100 families and continuation, requiring at least
128 distinct collected families and reporting how many have normalized projection
text; physical query counts alone are not enough. Query Store uses `ALL`, not
`AUTO`, so cheap seed queries survive.
Query-list text is initially lazy-loaded: `projectionFamilies: 0` in readiness
means summaries have not requested raw text yet, not that the seed is missing.
Reading family details hydrates and normalizes it. The SQL verification separately
requires all 128 projection queries and their captured runtime/plan rows.
SQL Server's parameter-sensitive variants may add more Query Store rows.
This is a small lifecycle smoke, not a sustained workload or performance fixture.

SQL permission/configuration references consulted:

- [Manage Query Store](https://learn.microsoft.com/sql/relational-databases/performance/manage-the-query-store)
- [sys.query_store_query: SQL Server 2022 permissions](https://learn.microsoft.com/sql/relational-databases/system-catalog-views/sys-query-store-query-transact-sql)
- [sys.query_store_query_text: server performance-state permission](https://learn.microsoft.com/sql/relational-databases/system-catalog-views/sys-query-store-query-text-transact-sql)
- [sys.dm_db_partition_stats: performance/security-definition permissions](https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/sys-dm-db-partition-stats-transact-sql)
- [sqlcmd password environment variable](https://learn.microsoft.com/sql/tools/sqlcmd/sqlcmd-utility#-p-password)
