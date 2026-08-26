#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Stretches a seeded measurement database's Query Store across more than 90 days.

.DESCRIPTION
    The rest of the rig seeds a Query Store that is minutes old. That is the right
    default -- it is quick, and it is enough for every probe measurement -- but it
    means the oldest interval sits well inside the 90-day horizon SQLSimCity enforces,
    so nothing that only engages on older history can be exercised at all. The initial
    backfill cap added by #87 never fires against it, and neither would a progressive
    backfill or a retention prune at the boundary.

    This script relabels the timeline of the history the engine really produced, and
    replicates it across a span you choose. It moves no clock: SQL Server on Linux runs
    the engine inside SQLPAL and does not take its time through the glibc symbols
    LD_PRELOAD interposes, so libfaketime loads into sqlservr and changes nothing the
    engine reports. See README.md for the measurements behind that.

    Run it against an already-seeded database, so changing the span does not mean
    paying for the 4,200-object seed again. Initialize-MeasureDatabase.ps1
    -DeepHistoryDays calls it for you at the end of a fresh seed.

.PARAMETER SpanDays
    How far back the oldest interval should sit. Defaults to 120, which clears the
    90-day horizon by a month so the cap has something to refuse rather than sitting
    exactly on the boundary.

.PARAMETER IntervalCount
    How many runtime-stats intervals the finished store should hold across that span.
    The real intervals already present are kept and reused as templates; the remainder
    are synthesized. Defaults to 240, one every twelve hours over 120 days.

.PARAMETER SkipLiveProof
    Skip the final workload pass. That pass exists to demonstrate the store is still
    live -- that the engine can still allocate an interval id after the transform --
    and skipping it saves about a minute at the cost of the only evidence that the
    id counter was re-derived rather than left to collide later.

.EXAMPLE
    ./Add-DeepHistory.ps1 -SpanDays 120 -IntervalCount 240
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 3650)][int]$SpanDays = 120,
    [ValidateRange(2, 20000)][int]$IntervalCount = 240,
    [switch]$SkipLiveProof,
    [int]$SchemaCount = 8,
    [string]$Container = 'sqlsimcity-measure-sql',
    [string]$Database = 'SimCityLoad',
    [string]$SaPassword = $(if ($env:SQLSIMCITY_MEASURE_SA_PASSWORD) { $env:SQLSIMCITY_MEASURE_SA_PASSWORD } else { 'Measure!Local1' })
)

$ErrorActionPreference = 'Stop'
$sqlcmd = '/opt/mssql-tools18/bin/sqlcmd'
$seedDir = Join-Path $PSScriptRoot 'seed'

# -I sets QUOTED_IDENTIFIER ON. sqlcmd leaves it OFF by default, and the transform
# reads sys.columns to build its column lists, which needs it.
function Invoke-Sql {
    param(
        [Parameter(Mandatory)][string]$Query,
        [switch]$Dac,
        [switch]$Raw,
        [string[]]$Variables = @()
    )
    $server = if ($Dac) { 'admin:localhost' } else { 'localhost' }
    $sqlcmdArgs = @('exec', $Container, $sqlcmd, '-S', $server, '-U', 'sa', '-P', $SaPassword,
                    '-C', '-b', '-I', '-d', $Database)
    if ($Raw) { $sqlcmdArgs += @('-h', '-1', '-W') }
    foreach ($v in $Variables) { $sqlcmdArgs += @('-v', $v) }
    $sqlcmdArgs += @('-Q', $Query)
    $output = & docker @sqlcmdArgs
    if ($LASTEXITCODE -ne 0) { throw "SQL failed:`n$($output -join "`n")" }
    return $output
}

function Invoke-SqlFile {
    param([Parameter(Mandatory)][string]$File, [switch]$Dac, [string[]]$Variables = @())
    $server = if ($Dac) { 'admin:localhost' } else { 'localhost' }
    $sqlcmdArgs = @('exec', $Container, $sqlcmd, '-S', $server, '-U', 'sa', '-P', $SaPassword,
                    '-C', '-b', '-I', '-d', $Database, '-i', "/seed/$File")
    foreach ($v in $Variables) { $sqlcmdArgs += @('-v', $v) }
    & docker @sqlcmdArgs
    if ($LASTEXITCODE -ne 0) { throw "Deep-history step failed: $File" }
}

# docker cp creates /seed when it is missing; the mkdir only matters on a container that
# has one already, and its "Permission denied" as the mssql user is noise, not a failure.
& docker exec $Container mkdir -p /seed 2>$null | Out-Null
& docker cp "$seedDir/." "${Container}:/seed/" | Out-Null

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

$intervalMinutes = [int](Invoke-Sql -Raw -Query `
    'SET NOCOUNT ON; SELECT interval_length_minutes FROM sys.database_query_store_options;' |
    Select-Object -First 1).Trim()

# Query Store cleanup is keyed off timestamps, and this script is about to make every
# timestamp in the store months old. A stale threshold below the span would leave the
# background cleanup task free to delete exactly the history being seeded -- the rig
# would look like it worked and then quietly empty out.
$requiredStaleDays = $SpanDays + 30
$currentStaleDays = [int](Invoke-Sql -Raw -Query `
    'SET NOCOUNT ON; SELECT stale_query_threshold_days FROM sys.database_query_store_options;' |
    Select-Object -First 1).Trim()
if ($currentStaleDays -lt $requiredStaleDays) {
    Write-Host "Raising STALE_QUERY_THRESHOLD_DAYS from $currentStaleDays to $requiredStaleDays (span is $SpanDays days)..."
    Invoke-Sql -Query "ALTER DATABASE [$Database] SET QUERY_STORE (CLEANUP_POLICY = (STALE_QUERY_THRESHOLD_DAYS = $requiredStaleDays));" | Out-Null
}

# The transform writes to the persisted internal tables. Anything still buffered in
# memory would be invisible to it, then flushed afterwards carrying present-day
# timestamps into a store that claims to be months old. A READ_ONLY store cannot flush
# at all, and the history passes are exactly what pushes it there, so wait rather than
# trusting a flush that may have done nothing.
Invoke-SqlFile -File 'wait-query-store-writable.sql' -Variables @('TimeoutSeconds=600')

Write-Host 'Flushing Query Store to disk...'
Invoke-Sql -Query 'EXEC sys.sp_query_store_flush_db;' | Out-Null

Write-Host "Stretching history over $SpanDays days into $IntervalCount intervals..."
Invoke-SqlFile -File '04-deep-history.sql' -Dac -Variables @(
    "SpanDays=$SpanDays", "IntervalCount=$IntervalCount", "IntervalLengthMinutes=$intervalMinutes")

Write-Host 'Re-seating Query Store so the engine re-derives its interval-id counter...'
Invoke-SqlFile -File '05-query-store-reseat.sql'

if (-not $SkipLiveProof) {
    # An interval-id collision would not show up in any of the counts above. It shows up
    # the next time the engine tries to open an interval -- which, after the re-seat, is
    # the next workload pass. One small pass is enough: the counter is re-derived once,
    # so if the first allocation lands, every later one does too.
    Write-Host 'Proving the store is still live (one workload pass)...'
    $before = [int](Invoke-Sql -Raw -Query `
        'SET NOCOUNT ON; SELECT COUNT(*) FROM sys.query_store_runtime_stats_interval;' |
        Select-Object -First 1).Trim()
    Invoke-Sql -Query "EXEC dbo.RunWorkload @FamilyCount = 25, @SchemaCount = $SchemaCount; EXEC sys.sp_query_store_flush_db;" | Out-Null
    $after = [int](Invoke-Sql -Raw -Query `
        'SET NOCOUNT ON; SELECT COUNT(*) FROM sys.query_store_runtime_stats_interval;' |
        Select-Object -First 1).Trim()
    if ($after -le $before) {
        throw "Query Store did not open a new interval after the transform ($before -> $after). The engine's interval-id counter may be colliding with synthesized ids."
    }
    Write-Host "  intervals $before -> $after"
}

Write-Host ''
Write-Host ("Deep history added in {0:mm\:ss}." -f $stopwatch.Elapsed)
Write-Host 'Measured span of sys.query_store_runtime_stats_interval:'
Invoke-SqlFile -File '06-verify-deep-history.sql' -Dac
