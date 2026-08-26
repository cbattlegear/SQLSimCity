#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Seeds the measurement database and builds Query Store history.

.DESCRIPTION
    Runs the three seed scripts in order, then executes the workload repeatedly with
    pauses so the history spans several runtime-stats intervals.

    The pauses are the point, not padding. Query Store buckets runtime statistics per
    interval, so a workload run in one burst produces one interval no matter how many
    queries it issues -- and paging over sys.query_store_runtime_stats is exercised by
    interval count multiplied by plan count. Seeding without the pauses produces a store
    that looks populated and cannot exercise the behaviour it exists to measure.

    The history this builds is minutes old, which is right for every probe measurement
    and useless for anything that only engages past the 90-day horizon. Pass
    -DeepHistoryDays to hand off to Add-DeepHistory.ps1 at the end and stretch it. That
    is opt-in on purpose: it adds a couple of minutes, and the ordinary setup should not
    pay for a case most measurements do not need.

.PARAMETER DeepHistoryDays
    Stretch the finished store back this many days. 0, the default, leaves the fast
    path exactly as it was.
#>
[CmdletBinding()]
param(
    [int]$TableCount = 4200,
    [int]$SchemaCount = 8,
    [int]$FamilyCount = 400,
    # Each pass lands in a new 1-minute interval, so this is also the interval count.
    [int]$HistoryPasses = 8,
    [int]$PauseSeconds = 45,
    [ValidateRange(0, 3650)][int]$DeepHistoryDays = 0,
    [ValidateRange(2, 20000)][int]$DeepHistoryIntervals = 240,
    [string]$Container = 'sqlsimcity-measure-sql',
    [string]$Database = 'SimCityLoad',
    [string]$SaPassword = $(if ($env:SQLSIMCITY_MEASURE_SA_PASSWORD) { $env:SQLSIMCITY_MEASURE_SA_PASSWORD } else { 'Measure!Local1' }),
    [string]$ReaderPassword = $(if ($env:SQLSIMCITY_MEASURE_READER_PASSWORD) { $env:SQLSIMCITY_MEASURE_READER_PASSWORD } else { 'Reader!Local1' })
)

$ErrorActionPreference = 'Stop'
$sqlcmd = '/opt/mssql-tools18/bin/sqlcmd'
$seedDir = Join-Path $PSScriptRoot 'seed'

function Invoke-Seed {
    param([string]$File, [string[]]$Variables = @(), [string]$InDatabase)
    $sqlcmdArgs = @('exec', $Container, $sqlcmd, '-S', 'localhost', '-U', 'sa',
                    '-P', $SaPassword, '-C', '-b', '-i', "/seed/$File")
    if ($InDatabase) { $sqlcmdArgs += @('-d', $InDatabase) }
    foreach ($v in $Variables) { $sqlcmdArgs += @('-v', $v) }
    & docker @sqlcmdArgs
    if ($LASTEXITCODE -ne 0) { throw "Seed step failed: $File" }
}

Write-Host 'Waiting for SQL Server to report healthy...'
$deadline = (Get-Date).AddMinutes(5)
while ((Get-Date) -lt $deadline) {
    $status = (& docker inspect --format '{{.State.Health.Status}}' $Container 2>$null)
    if ($status -eq 'healthy') { break }
    Start-Sleep -Seconds 3
}
if ($status -ne 'healthy') { throw "Container $Container did not become healthy." }

# docker cp creates /seed when it is missing; the mkdir only matters on a container that
# has one already, and its "Permission denied" as the mssql user is noise, not a failure.
& docker exec $Container mkdir -p /seed 2>$null | Out-Null
& docker cp "$seedDir/." "${Container}:/seed/" | Out-Null

Write-Host 'Creating database and configuring Query Store...'
Invoke-Seed -File '01-database.sql' -Variables @(
    "DatabaseName=$Database", 'QueryStoreMaxSizeMb=2048', "ReaderPassword=$ReaderPassword",
    "StaleQueryThresholdDays=$(if ($DeepHistoryDays -gt 0) { $DeepHistoryDays + 30 } else { 30 })")

Write-Host "Creating $TableCount objects across $SchemaCount schemas (several minutes)..."
Invoke-Seed -File '02-objects.sql' -Variables @(
    "DatabaseName=$Database", "TableCount=$TableCount", "SchemaCount=$SchemaCount")

Write-Host 'Installing the workload generator...'
Invoke-Seed -File '03-workload.sql' -Variables @("DatabaseName=$Database")

Write-Host "Building history: $HistoryPasses passes, ${PauseSeconds}s apart..."
for ($pass = 1; $pass -le $HistoryPasses; $pass++) {
    # Before every pass, not just the first. Query Store drops into READ_ONLY when its
    # in-memory backlog fills, and these passes are what fills it, so a single check up
    # front leaves later passes free to run against a store that captures nothing.
    Invoke-Seed -File 'wait-query-store-writable.sql' -InDatabase $Database -Variables @('TimeoutSeconds=600')
    & docker exec $Container $sqlcmd -S localhost -U sa -P $SaPassword -C -b `
        -d $Database -o /dev/null `
        -Q "EXEC dbo.RunWorkload @FamilyCount = $FamilyCount, @SchemaCount = $SchemaCount;"
    if ($LASTEXITCODE -ne 0) { throw "Workload pass $pass failed." }
    # Draining the backlog after each pass is what keeps it from filling in the first
    # place. Without this the waits above still recover, but they recover by waiting.
    & docker exec $Container $sqlcmd -S localhost -U sa -P $SaPassword -C -b `
        -d $Database -o /dev/null -Q 'EXEC sys.sp_query_store_flush_db;'
    if ($LASTEXITCODE -ne 0) { throw "Query Store flush after pass $pass failed." }
    Write-Host "  pass $pass/$HistoryPasses"
    if ($pass -lt $HistoryPasses) { Start-Sleep -Seconds $PauseSeconds }
}

# A seed that captured nothing looks exactly like a seed that worked: the passes run to
# completion either way. One workload pass issues at least three statements per family, so
# anything at or below FamilyCount means capture was off for most of the run.
$capturedQueries = [int](& docker exec $Container $sqlcmd -S localhost -U sa -P $SaPassword -C -b `
    -d $Database -h -1 -W -Q 'SET NOCOUNT ON; SELECT COUNT(*) FROM sys.query_store_query;' |
    Select-Object -First 1).Trim()
if ($capturedQueries -le $FamilyCount) {
    throw "Query Store holds only $capturedQueries queries after $HistoryPasses passes over " +
          "$FamilyCount families. Capture was off for most of the run -- check " +
          'actual_state_desc and readonly_reason in sys.database_query_store_options.'
}
Write-Host "  captured $capturedQueries query families"

if ($DeepHistoryDays -gt 0) {
    Write-Host ''
    & (Join-Path $PSScriptRoot 'Add-DeepHistory.ps1') `
        -SpanDays $DeepHistoryDays -IntervalCount $DeepHistoryIntervals `
        -SchemaCount $SchemaCount `
        -Container $Container -Database $Database -SaPassword $SaPassword
}

$summary = & docker exec $Container $sqlcmd -S localhost -U sa -P $SaPassword -C `
    -d $Database -h -1 -W -Q @"
SET NOCOUNT ON;
SELECT CONCAT(
    'queries=', (SELECT COUNT(*) FROM sys.query_store_query),
    ' plans=', (SELECT COUNT(*) FROM sys.query_store_plan),
    ' intervals=', (SELECT COUNT(*) FROM sys.query_store_runtime_stats_interval),
    ' runtime_buckets=', (SELECT COUNT(*) FROM sys.query_store_runtime_stats),
    ' wait_buckets=', (SELECT COUNT(*) FROM sys.query_store_wait_stats),
    ' objects=', (SELECT COUNT(*) FROM sys.tables));
"@
Write-Host ''
Write-Host "Ready: $($summary | Select-Object -First 1)"
Write-Host "Connection string for connected mode:"
Write-Host "  Server=127.0.0.1,11433;Database=$Database;User Id=sqlsimcity_reader;Password=$ReaderPassword;TrustServerCertificate=true"
