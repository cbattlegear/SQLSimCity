#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Measures what a SQLSimCity probe costs the instance it is pointed at.

.DESCRIPTION
    Runs probe SQL from sql/probes/ against the seeded measurement database and
    reports elapsed time, logical reads, and (optionally) the execution plan.

    This exists because three of the performance issues on this repository turn on
    a question no amount of reading settles: whether SQL Server pushes a keyset
    predicate below an aggregate, what a 24-hour Query Store window actually costs,
    and how those scale with history depth. A number from this script is evidence;
    an estimate from reading the SQL is not.

    Logical reads come from SET STATISTICS IO, parsed out of the informational
    messages rather than from a timer, so the figure is the work the engine did
    and not the round trip.

.PARAMETER Probe
    Path to a .sql probe file, relative to the repository root or absolute.

.PARAMETER Parameters
    Probe parameters, e.g. @{ StartTime = '2026-01-01'; PageSize = 1000 }.

.PARAMETER ShowPlan
    Capture the estimated execution plan instead of executing. Use this to answer
    "where did the predicate end up", which is the only thing that settles #81.

.PARAMETER Iterations
    Repeat count. The first execution is discarded as a warm-up so the reported
    figure is not dominated by compilation.

.EXAMPLE
    ./Measure-Probe.ps1 -Probe sql/probes/querystore/query_store_runtime_page_2022.sql `
        -Parameters @{ StartTime='2026-01-01T00:00:00'; EndTime='2030-01-01T00:00:00';
                       PageSize=1000; AfterIntervalId=0; AfterPlanId=0;
                       AfterExecutionType=0; AfterReplicaGroupId=0 }
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Probe,
    [hashtable]$Parameters = @{},
    [switch]$ShowPlan,
    [int]$Iterations = 3,
    [string]$Container = 'sqlsimcity-measure-sql',
    [string]$Database = 'SimCityLoad',
    [string]$SaPassword = $(if ($env:SQLSIMCITY_MEASURE_SA_PASSWORD) { $env:SQLSIMCITY_MEASURE_SA_PASSWORD } else { 'Measure!Local1' })
)

$ErrorActionPreference = 'Stop'
$sqlcmd = '/opt/mssql-tools18/bin/sqlcmd'

if (-not (Test-Path $Probe)) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $candidate = Join-Path $repoRoot $Probe
    if (Test-Path $candidate) { $Probe = $candidate }
    else { throw "Probe not found: $Probe" }
}

$probeText = Get-Content -Raw -LiteralPath $Probe

# The probes declare their parameters as @Name references. Bind them with
# sp_executesql rather than string substitution, so the measured statement is
# parameterized exactly as the collector issues it -- a literal-substituted
# variant can get a different plan and would measure the wrong thing.
$declarations = @()
$assignments = @()
foreach ($key in $Parameters.Keys) {
    $value = $Parameters[$key]
    $type = switch ($value) {
        { $_ -is [int] -or $_ -is [long] } { 'bigint'; break }
        { $_ -is [bool] } { 'bit'; break }
        default { 'nvarchar(400)' }
    }
    $literal = if ($value -is [bool]) { if ($value) { '1' } else { '0' } }
               elseif ($value -is [int] -or $value -is [long]) { "$value" }
               else { "N'" + ($value -replace "'", "''") + "'" }
    $declarations += "DECLARE @$key $type = $literal;"
    $assignments += "@$key"
}

$prelude = ($declarations -join "`n")
$body = $probeText

function Invoke-Sqlcmd-InContainer {
    param([string]$Text, [string[]]$ExtraArgs = @())
    $tmp = [System.IO.Path]::GetRandomFileName() + '.sql'
    $hostTmp = Join-Path ([System.IO.Path]::GetTempPath()) $tmp
    Set-Content -LiteralPath $hostTmp -Value $Text -Encoding UTF8
    try {
        docker cp $hostTmp "${Container}:/tmp/$tmp" | Out-Null
        $sqlcmdArgs = @('exec', $Container, $sqlcmd, '-S', 'localhost', '-U', 'sa',
                  '-P', $SaPassword, '-C', '-d', $Database, '-i', "/tmp/$tmp") + $ExtraArgs
        $output = & docker @sqlcmdArgs 2>&1
        return ,$output
    }
    finally {
        Remove-Item -LiteralPath $hostTmp -ErrorAction SilentlyContinue
        docker exec $Container rm -f "/tmp/$tmp" 2>&1 | Out-Null
    }
}

if ($ShowPlan) {
    $planScript = "SET SHOWPLAN_XML ON;`nGO`n$prelude`n$body"
    $output = Invoke-Sqlcmd-InContainer -Text $planScript -ExtraArgs @('-y', '0', '-h', '-1')
    $xml = ($output | Where-Object { $_ -match '<ShowPlanXML' }) -join "`n"
    if (-not $xml) {
        Write-Warning 'No plan XML returned. Raw output follows.'
        $output | Select-Object -Last 20
        return
    }
    [pscustomobject]@{
        Probe = Split-Path -Leaf $Probe
        PlanXml = $xml
    }
    return
}

$results = @()
for ($i = 0; $i -lt $Iterations; $i++) {
    # One batch, no GO: a batch boundary would discard the DECLAREs before the
    # probe body could reference them, and the probe would fail silently while
    # the wall clock still reported a plausible-looking number.
    $runScript = "SET STATISTICS IO ON;`nSET STATISTICS TIME ON;`n$prelude`n$body"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $output = Invoke-Sqlcmd-InContainer -Text $runScript
    $sw.Stop()

    $errors = $output | Where-Object { [string]$_ -match '^Msg \d+, Level' }
    if ($errors) {
        throw "Probe failed against the measurement database:`n" + (($output | Select-Object -Last 15) -join "`n")
    }

    $logicalReads = 0
    foreach ($line in $output) {
        foreach ($m in [regex]::Matches([string]$line, 'logical reads (\d+)')) {
            $logicalReads += [int]$m.Groups[1].Value
        }
    }
    $cpuMs = 0
    foreach ($line in $output) {
        $m = [regex]::Match([string]$line, 'CPU time = (\d+) ms')
        if ($m.Success) { $cpuMs += [int]$m.Groups[1].Value }
    }

    $results += [pscustomobject]@{
        Iteration    = $i
        WarmUp       = ($i -eq 0)
        WallMs       = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
        CpuMs        = $cpuMs
        LogicalReads = $logicalReads
    }
}

$measured = $results | Where-Object { -not $_.WarmUp }
[pscustomobject]@{
    Probe           = Split-Path -Leaf $Probe
    Iterations      = $measured.Count
    MedianWallMs    = ($measured.WallMs | Sort-Object)[[int]($measured.Count / 2)]
    MedianCpuMs     = ($measured.CpuMs | Sort-Object)[[int]($measured.Count / 2)]
    MedianReads     = ($measured.LogicalReads | Sort-Object)[[int]($measured.Count / 2)]
    Detail          = $results
}
