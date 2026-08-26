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
#>
[CmdletBinding()]
param(
    [int]$TableCount = 4200,
    [int]$SchemaCount = 8,
    [int]$FamilyCount = 400,
    # Each pass lands in a new 1-minute interval, so this is also the interval count.
    [int]$HistoryPasses = 8,
    [int]$PauseSeconds = 45,
    [string]$Container = 'sqlsimcity-measure-sql',
    [string]$Database = 'SimCityLoad',
    [string]$SaPassword = $(if ($env:SQLSIMCITY_MEASURE_SA_PASSWORD) { $env:SQLSIMCITY_MEASURE_SA_PASSWORD } else { 'Measure!Local1' }),
    [string]$ReaderPassword = $(if ($env:SQLSIMCITY_MEASURE_READER_PASSWORD) { $env:SQLSIMCITY_MEASURE_READER_PASSWORD } else { 'Reader!Local1' })
)

$ErrorActionPreference = 'Stop'
$sqlcmd = '/opt/mssql-tools18/bin/sqlcmd'
$seedDir = Join-Path $PSScriptRoot 'seed'

function Invoke-Seed {
    param([string]$File, [string[]]$Variables = @())
    $sqlcmdArgs = @('exec', $Container, $sqlcmd, '-S', 'localhost', '-U', 'sa',
                    '-P', $SaPassword, '-C', '-b', '-i', "/seed/$File")
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

& docker exec $Container mkdir -p /seed | Out-Null
& docker cp "$seedDir/." "${Container}:/seed/" | Out-Null

Write-Host 'Creating database and configuring Query Store...'
Invoke-Seed -File '01-database.sql' -Variables @(
    "DatabaseName=$Database", 'QueryStoreMaxSizeMb=2048', "ReaderPassword=$ReaderPassword")

Write-Host "Creating $TableCount objects across $SchemaCount schemas (several minutes)..."
Invoke-Seed -File '02-objects.sql' -Variables @(
    "DatabaseName=$Database", "TableCount=$TableCount", "SchemaCount=$SchemaCount")

Write-Host 'Installing the workload generator...'
Invoke-Seed -File '03-workload.sql' -Variables @("DatabaseName=$Database")

Write-Host "Building history: $HistoryPasses passes, ${PauseSeconds}s apart..."
for ($pass = 1; $pass -le $HistoryPasses; $pass++) {
    & docker exec $Container $sqlcmd -S localhost -U sa -P $SaPassword -C -b `
        -d $Database -o /dev/null `
        -Q "EXEC dbo.RunWorkload @FamilyCount = $FamilyCount, @SchemaCount = $SchemaCount;"
    if ($LASTEXITCODE -ne 0) { throw "Workload pass $pass failed." }
    Write-Host "  pass $pass/$HistoryPasses"
    if ($pass -lt $HistoryPasses) { Start-Sleep -Seconds $PauseSeconds }
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
