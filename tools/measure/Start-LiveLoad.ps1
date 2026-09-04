#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Keeps queries actually running on the measurement instance, so the live views have
    something to show.

.DESCRIPTION
    Initialize-MeasureDatabase.ps1 builds *history*: a large Query Store that the city is
    drawn from. It deliberately leaves nothing running afterwards, and for most measurements
    that is correct -- the roads, the buildings and the address book are all drawn from
    retained plans and do not care whether anything is executing right now.

    The live layers do care, and they are invisible without this. Vehicles come from
    sys.dm_exec_requests, and a request only appears there while its batch is actually on a
    worker. So a measurement of the vehicle layer taken against a seeded-but-idle instance
    measures an empty roster wearing a populated city's name, and every frame cost it reports
    is the cost of drawing nothing.

    Two three things this has to get right, none of which is automatic:

    - The running statements must be the *same* statements Query Store captured. A vehicle is
      matched to a road by query_hash, so load that merely keeps the instance busy -- a loop of
      WAITFOR, or ad-hoc SELECTs written fresh here -- produces live requests that match no
      query family and no road, and draws no vehicles at all. This runs dbo.RunWorkload, which
      is the same procedure the seed ran, so the hashes line up by construction.

    - Matching the hash is necessary and not sufficient: the family it matches has to span
      *two* objects. A road is co-reference -- one query family that touched two objects -- so
      a family that reads a single table draws no road, and a vehicle has nowhere to be put.
      dbo.RunWorkload is entirely single-table, so an instance seeded and driven by it alone
      produces a city with 4,200 buildings, 5,900 retained plans, live requests whose hashes
      match, and *zero* roads. Measured on this rig before -JoinWorkers existed: 175 pages
      walked, `routes = 0` on every one, six attributed families holding exactly one object
      each, and the sidebar reporting "16 unplaced". Nothing about that looks like a rig gap
      from the browser -- it looks exactly like a broken vehicle feature, which is why it is
      worth stating here rather than rediscovering.

      -JoinWorkers fixes it by running a two-table join per worker. Each worker's statement
      text is fixed for its pair, so the pair keeps one stable query_hash across executions
      while different pairs are different families.

    - Blocking has to be real. -Blockers opens a transaction that takes and holds an X lock,
      and points readers at the same rows, so sys.dm_exec_requests reports genuine
      blocking_session_id values rather than the zero a healthy instance reports. That is the
      only way to see a vehicle halt at an incident. The lock is held by an open transaction
      that is rolled back on exit; nothing here is committed.

    Everything runs as sqlcmd inside the container, so the host needs no SQL client driver.
    Workers are PowerShell jobs; Stop-LiveLoad is just Ctrl-C, or letting -DurationSeconds
    expire, after which the container has no sessions left from this script.

.PARAMETER Connections
    Concurrent workers running the captured workload. Each is one session, so this is roughly
    the number of live requests the API will see, and therefore the vehicle count before
    per-session-and-family collapsing.

    Keep this modest. The browser harness next door walks ~80 pages of the city against the same
    instance before it measures anything, and that walk competes with the load: 20 workers over
    4,200 objects starved the page walk badly enough that it never settled inside its 15-minute
    timeout. The load exists to put rows in sys.dm_exec_requests, not to benchmark the engine.

.PARAMETER Blockers
    Blocking chains to hold open. Each is one transaction holding an X lock plus -BlockedPerBlocker
    readers stuck behind it.

    Note that the ordinary workers also read the locked table when their pass reaches it, so the
    blocked count observed is normally well above -BlockedPerBlocker.

.NOTES
    Stopping: run "Get-Job | Stop-Job; Get-Job | Remove-Job -Force" *in the shell that started
    this*. Jobs belong to their creating session, so killing that shell from outside orphans the
    worker processes instead of stopping them -- they keep their sessions open on the instance
    and are then only reachable by process id.

.EXAMPLE
    ./Start-LiveLoad.ps1 -Connections 8 -DurationSeconds 1200
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 200)][int]$Connections = 8,
    [ValidateRange(0, 20)][int]$Blockers = 1,
    [ValidateRange(1, 20)][int]$BlockedPerBlocker = 3,
    [ValidateRange(30, 7200)][int]$DurationSeconds = 900,
    # Fewer families per pass than the seed used: a pass has to be short enough that the
    # workers keep re-entering it, because a worker sitting in one long pass shows the same
    # single query_hash for minutes and the roster stops moving.
    [ValidateRange(1, 400)][int]$FamiliesPerPass = 60,
    # Workers running a two-table join, which is the only thing here that draws a road. Each
    # takes a disjoint pair, so this is also the number of distinct roads live traffic can use.
    [ValidateRange(0, 40)][int]$JoinWorkers = 3,
    <#
        Join workers whose statement is made expensive rather than fast, so that the live sampler
        can actually see one. See the long comment beside $slowJoinSql: a fast workload produces an
        empty vehicle roster no matter how much traffic it drives, and -Blockers can only ever show
        vehicles standing still. This is the only setting that yields a *moving* vehicle.
    #>
    [ValidateRange(0, 12)][int]$SlowJoins = 2,
    <#
        Explicit table pairs for the join workers, each 'schema.table|schema.table'.

        This exists because "two objects" is still not sufficient: a route is emitted only when
        *both* endpoints are on the same page of /api/v1/database-city, and that page holds 24
        of 4,200 objects. Pairs chosen by size land on different pages and produce a family the
        API describes, in its own rationale, as "1 referenced object(s) exist in this database
        but are outside the current page" -- confidence Probable, two objects, and still no
        road. Measured: pairs on pages 16/161, 44/73 and 103/132, routes = 0 on all 175 pages.

        So take pairs from page 1's `objects` array and they are co-located by construction.
        The default below is page 1 of the standard seed, three pairs within one schema each.
    #>
    [string[]]$JoinPairs = @(
        'app6.entity_206|app6.entity_1414',
        'app6.entity_2622|app7.entity_743',
        'app7.entity_2935|app7.entity_4143',
        'app8.entity_1056|app8.entity_2264',
        'app8.entity_3472|app1.entity_2801',
        'app1.entity_385|app1.entity_1593'
    ),
    [string]$Container = 'sqlsimcity-measure-sql',
    [string]$Database = 'SimCityLoad',
    [string]$SaPassword = $(if ($env:SQLSIMCITY_MEASURE_SA_PASSWORD) { $env:SQLSIMCITY_MEASURE_SA_PASSWORD } else { 'Measure!Local1' })
)

$ErrorActionPreference = 'Stop'
$sqlcmd = '/opt/mssql-tools18/bin/sqlcmd'

$status = (& docker inspect --format '{{.State.Health.Status}}' $Container 2>$null)
if ($status -ne 'healthy') {
    throw "Container '$Container' is not healthy (got '$status'). Run Initialize-MeasureDatabase.ps1 first."
}

# -t 0 disables sqlcmd's own query timeout. Without it a blocked reader is killed at 30s and
# the block heals itself halfway through the measurement, which looks like a flaky probe.
#
# -o /dev/null is not tidiness, it is the difference between a load generator and a memory leak
# that takes the machine down. dbo.RunWorkload returns a result set per shape per family, and
# every row sqlcmd prints travels back through docker exec into the job's output stream, where
# PowerShell buffers it for a Receive-Job that never comes. Measured: twenty workers left running
# for half an hour held ~1.8 GB each and the parent shell 10 GB, which exhausted 32 GB of RAM,
# and the first symptom was not "the rig is using memory" -- it was SQL Server timing out its
# pre-login handshake and Docker's engine API returning 500, i.e. the instance under measurement
# appearing to fail. Discard the rows at the server; nothing here ever reads them.
function Start-Worker {
    param([string]$Name, [string]$Sql)
    Start-Job -Name $Name -ScriptBlock {
        param($container, $sqlcmd, $password, $database, $sql)
        & docker exec $container $sqlcmd -S localhost -U sa -P $password -C -b -t 0 `
            -d $database -Q $sql -o /dev/null 2>&1 | Out-Null
    } -ArgumentList $Container, $sqlcmd, $SaPassword, $Database, $Sql
}

$deadline = "DATEADD(second, $DurationSeconds, SYSUTCDATETIME())"

$jobs = @()

$workloadSql = @"
SET NOCOUNT ON;
DECLARE @end datetime2(0) = $deadline;
WHILE SYSUTCDATETIME() < @end
BEGIN
    EXEC dbo.RunWorkload @FamilyCount = $FamiliesPerPass, @SchemaCount = 8;
END
"@

for ($i = 1; $i -le $Connections; $i++) {
    $jobs += Start-Worker -Name "load-$i" -Sql $workloadSql
}

<#
    The join workers. Worker n takes tables at ordinal 2n and 2n+1 of the largest-first list,
    so pairs are disjoint and every worker draws its own road.

    The pair is looked up rather than named. Hardcoding a table here was already wrong once for
    the blocker -- the seed spreads entity_N round-robin over eight schemas, so [app1].[entity_38]
    does not exist -- and a wrong name in a join is worse, because the batch fails instantly and
    the worker simply contributes nothing rather than erroring anywhere visible.

    sp_executesql with a fixed statement per pair keeps one query_hash per pair across every
    execution. The count goes into an OUTPUT variable so no rows travel back to the client; see
    the note on Start-Worker above for why that matters.
#>
$joinSql = @"
SET NOCOUNT ON;
DECLARE @end datetime2(0) = $deadline;
DECLARE @c int;

IF OBJECT_ID('__LEFT__') IS NULL OR OBJECT_ID('__RIGHT__') IS NULL
    THROW 51001, 'A join pair names a table that does not exist.', 1;

WHILE SYSUTCDATETIME() < @end
BEGIN
    SELECT @c = COUNT(*)
    FROM __LEFT__ AS a
    JOIN __RIGHT__ AS b ON b.tenant_id = a.tenant_id AND b.amount > a.amount;
END
"@

$pairCount = [Math]::Min($JoinWorkers, $JoinPairs.Count)
for ($j = 0; $j -lt $pairCount; $j++) {
    $parts = $JoinPairs[$j] -split '\|'
    if ($parts.Count -ne 2) { throw "JoinPairs entry '$($JoinPairs[$j])' is not 'schema.table|schema.table'." }
    $left = ($parts[0] -split '\.') -join '].['
    $right = ($parts[1] -split '\.') -join '].['
    $sql = $joinSql.Replace('__LEFT__', "[$left]").Replace('__RIGHT__', "[$right]")
    $jobs += Start-Worker -Name "join-$j" -Sql $sql
}

<#
    Slow joins exist because of a sampling property that is easy to mistake for a broken feature.

    /api/v1/live reports what `sys.dm_exec_requests` held at one instant. A query that starts and
    finishes between two samples was never observed at all -- the API says so itself in its own
    footnote -- so a *fast* workload can drive real traffic down real roads and still produce an
    empty vehicle roster, over and over. Measured here: 6 join workers hammering the equality join
    above kept only 7 requests visible and matched **zero** road families, because each statement
    completed in milliseconds.

    The obvious fix is to make queries wait on a lock, and that is what -Blockers does. It is the
    wrong tool for measuring *motion*: a blocked vehicle is correctly drawn stopped, so a roster
    full of blocked requests parks every vehicle and the animation loop shuts down exactly as
    designed. That is worth measuring on purpose, but it cannot show the loop running.

    So this worker makes a query genuinely expensive rather than genuinely stuck. Dropping the
    tenant_id equality leaves the range predicate alone to join 5,000 rows against 5,000, and
    MAXDOP 1 stops the optimiser hiding it across cores. The statement then runs for seconds,
    holds no locks anyone else wants, and is therefore visible in every sample.
#>
$slowJoinSql = @"
SET NOCOUNT ON;
DECLARE @end datetime2(0) = $deadline;
DECLARE @c int;

IF OBJECT_ID('__LEFT__') IS NULL OR OBJECT_ID('__RIGHT__') IS NULL
    THROW 51001, 'A join pair names a table that does not exist.', 1;

WHILE SYSUTCDATETIME() < @end
BEGIN
    SELECT @c = COUNT(*)
    FROM __LEFT__ AS a
    JOIN __RIGHT__ AS b ON b.amount > a.amount
    OPTION (MAXDOP 1);
END
"@

$slowCount = [Math]::Min($SlowJoins, $JoinPairs.Count)
for ($s = 0; $s -lt $slowCount; $s++) {
    $parts = $JoinPairs[$s] -split '\|'
    $left = ($parts[0] -split '\.') -join '].['
    $right = ($parts[1] -split '\.') -join '].['
    $sql = $slowJoinSql.Replace('__LEFT__', "[$left]").Replace('__RIGHT__', "[$right]")
    $jobs += Start-Worker -Name "slowjoin-$s" -Sql $sql
}

# Tables the blockers may lock, resolved from the instance rather than derived from the seed's
# shape.
#
# The previous derivation computed the schema arithmetically -- entity_38 lives in app6 because
# 02-objects.sql spreads tables round-robin over eight schemas. That is true of the standard seed
# and false of any smaller one: SimCitySmall has 64 tables over *three* schemas, so the derived
# [app6].[entity_38] does not exist there, and the failure surfaces as "0 blocked" -- which reads
# as a broken incident feature rather than a rig that locked nothing. Asking the instance which
# tables exist costs one round trip and works on any seed.
#
# entity_1 is still excluded: the join shape reads it constantly, so a lock there stalls every
# worker rather than a nameable few. `amount` is required because that is the column the blocking
# UPDATE writes.
$lockTableSql = @'
SET NOCOUNT ON;
SELECT TOP (20) s.name + '.' + t.name
FROM sys.tables AS t
JOIN sys.schemas AS s ON s.schema_id = t.schema_id
WHERE t.name <> 'entity_1'
  AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = 'amount')
  AND EXISTS (SELECT 1 FROM sys.columns AS c WHERE c.object_id = t.object_id AND c.name = 'label')
ORDER BY t.name;
'@
$lockTables = @(
    & docker exec $Container $sqlcmd -S localhost -U sa -P $SaPassword -C -b -t 0 `
        -d $Database -Q $lockTableSql -h -1 -W 2>&1 |
        ForEach-Object { "$_".Trim() } |
        Where-Object { $_ -match '^\w+\.\w+$' }
)
if ($lockTables.Count -eq 0) {
    throw "No lockable table found in '$Database'. Expected tables with 'amount' and 'label' columns, as the seed builds."
}

for ($b = 1; $b -le $Blockers; $b++) {
    # A distinct table per chain, so two chains block independently and the city shows more
    # than one incident. Spread across the resolved list rather than taken consecutively, so a
    # small database with few tables still gives the chains different tables where it can.
    $parts = $lockTables[(($b - 1) * 7) % $lockTables.Count] -split '\.'
    $table = "[$($parts[0])].[$($parts[1])]"

    $blockerSql = @"
SET NOCOUNT ON;
BEGIN TRANSACTION;
UPDATE TOP (1) $table WITH (TABLOCKX) SET amount = amount;
WAITFOR DELAY '$( [TimeSpan]::FromSeconds($DurationSeconds).ToString('hh\:mm\:ss') )';
ROLLBACK TRANSACTION;
"@
    $jobs += Start-Worker -Name "blocker-$b" -Sql $blockerSql

    # The blocked readers run shape 3 verbatim -- same text, same sp_executesql parameterisation
    # as the seed -- so the halted vehicle belongs to a family that has a road.
    #
    # TABLOCKX above is what makes that reliable rather than lucky. A bare row-level X lock is only
    # a block if the reader's plan happens to touch the locked row, and shape 3 filters on `label`,
    # which the seed indexes -- so the optimizer can answer COUNT_BIG(*) from the nonclustered index
    # and never visit the clustered row the UPDATE holds. Measured against SimCitySmall: two
    # blockers holding X locks on app1.entity_10 and app2.entity_17, three readers per chain
    # scanning exactly those tables, and `blocking_session_id = 0` on every one of them. The lock
    # was real, the readers were real, and nothing was blocked -- which reads from the browser as
    # an incident layer that does not work. Locking the table removes the access path from the
    # question; the block is no less genuine for being taken at a coarser granularity.
    $blockedSql = @"
SET NOCOUNT ON;
DECLARE @end datetime2(0) = $deadline;
DECLARE @sql nvarchar(max) = N'SELECT COUNT_BIG(*) FROM $table WHERE label LIKE @pattern;';
WHILE SYSUTCDATETIME() < @end
BEGIN
    EXEC sys.sp_executesql @sql, N'@pattern nvarchar(64)', @pattern = N'%x%';
END
"@
    for ($r = 1; $r -le $BlockedPerBlocker; $r++) {
        $jobs += Start-Worker -Name "blocked-$b-$r" -Sql $blockedSql
    }
}

Write-Host "Started $($jobs.Count) sessions for ${DurationSeconds}s ($Connections load, $Blockers blocked chains)."

<#
    A load generator that reports "started" while every connection is in fact failing looks
    exactly like a healthy instance with nothing running: both leave the live views empty, and
    the empty view is then read as a bug in the thing being measured. So the counts are read
    back from the instance and disagreement is thrown, not printed.
#>
Start-Sleep -Seconds 15
$countSql = @'
SET NOCOUNT ON;
SELECT COUNT(*) AS running,
       SUM(CASE WHEN r.blocking_session_id <> 0 THEN 1 ELSE 0 END) AS blocked
FROM sys.dm_exec_requests AS r
JOIN sys.dm_exec_sessions AS s ON s.session_id = r.session_id
WHERE s.is_user_process = 1 AND r.session_id <> @@SPID;
'@
$counts = & docker exec $Container $sqlcmd -S localhost -U sa -P $SaPassword -C -h -1 -W -b -d $Database -Q $countSql
$parsed = ($counts | Where-Object { $_ -match '^\s*\d+\s+\d+\s*$' } | Select-Object -First 1) -split '\s+' |
    Where-Object { $_ -ne '' }
$running = if ($parsed) { [int]$parsed[0] } else { 0 }
$blocked = if ($parsed -and $parsed.Count -gt 1) { [int]$parsed[1] } else { 0 }

Get-Job | Where-Object { $_.State -eq 'Failed' } | ForEach-Object { Receive-Job $_ 2>&1 | Write-Warning }

Write-Host "sys.dm_exec_requests reports $running running, $blocked blocked."
if ($running -lt [Math]::Max(2, [int]($Connections / 4))) {
    throw "Only $running requests are running. The workers are failing; check dbo.RunWorkload exists in $Database."
}
if ($Blockers -gt 0 -and $blocked -lt 1) {
    throw "No request is blocked, but $Blockers blocking chains were asked for. The blocker's UPDATE is probably naming a table that does not exist -- check the derived schema."
}

Write-Host 'Sessions are live. Run the browser measurement now; Get-Job | Remove-Job -Force to stop.'
