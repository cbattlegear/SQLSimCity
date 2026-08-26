#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Measures what one HTTP request costs the SQLSimCity API process.

.DESCRIPTION
    Stands up the API in connected mode against the tools/measure rig, drives a set of
    routes over HTTP from a single warm HttpClient, and reports median and spread per
    route along with the bytes that actually went on the wire.

    This is the tier between the two existing workbenches: tools/measure measures what a
    probe costs the SQL Server being watched, tools/measure-browser measures what the app
    costs the browser, and nothing measured the process in the middle. PR #94 needed
    exactly this to size the findings recompute -- /api/v1/findings/status at 388.59 ms
    against 1.67 ms of rules -- built it as scratch, and correctly deleted it.

    Four things this does that a curl loop does not, each of which produced a wrong
    number at least once on this repository:

    * One process, one connection, one warmed HttpClient. Measure-Probe.ps1 reports
      server-side elapsed separately because `docker exec` and sqlcmd start-up add
      roughly 300 ms per invocation. `curl.exe` in a loop has the same problem, and it
      swamps every route here except the findings ones.
    * The floor is measured, not assumed. /healthz does no work, so its median is the
      loopback-plus-Kestrel-plus-harness cost, and OverFloorMs is what the route added.
    * Accept-Encoding is honoured and the response is NOT auto-decompressed, so Bytes is
      what a client waits for and IdentityBytes is what it ends up with.
    * Any unexpected status is fatal. A rate-limited loop measures 44-byte rejection
      bodies and reports them as if they were responses, which is what happened in #84.

.PARAMETER ConnectionString
    The connected target. Defaults to $env:ConnectionStrings__SqlSimCity, then to the
    tools/measure rig on 127.0.0.1,11433.

.PARAMETER BaseUrl
    Measure an API that is already running instead of starting one. You are then
    responsible for its configuration -- see -ApiPermitLimit.

.PARAMETER Route
    Routes to measure. Defaults to a set spanning the cheap and the expensive.

.PARAMETER AcceptEncoding
    One measurement pass per value. Pass 'br, gzip', 'identity' to see both what
    compression saves on the wire and what it costs in time.

.PARAMETER ResetStore
    Clear the protected store before starting. Two runs are only comparable if both start
    from the same store, because the collector keeps filling it between runs.

.EXAMPLE
    ./Measure-Api.ps1

.EXAMPLE
    ./Measure-Api.ps1 -Route '/healthz', '/api/v1/findings/status' -Iterations 30

.EXAMPLE
    ./Measure-Api.ps1 -AcceptEncoding 'br, gzip', 'identity' -Json after.json -Label after
#>
[CmdletBinding()]
param(
    [string]$ConnectionString,
    [string]$BaseUrl,
    [string[]]$Route,
    [string[]]$AcceptEncoding = @('br, gzip'),
    [int]$Iterations = 15,
    [int]$WarmUp = 3,
    [int[]]$ExpectStatus = @(200),
    [int]$Port = 5099,
    [int]$ApiPermitLimit = 10000,
    [int]$ReadySeconds = 300,
    [string]$PublishDirectory,
    [switch]$Rebuild,
    [switch]$ResetStore,
    [switch]$KeepRunning,
    [switch]$SkipCollectorWait,
    [string]$Json,
    [string]$Label
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# /healthz returns a constant and touches nothing, so its median is the cost of the
# measurement itself -- loopback, Kestrel, middleware, and this harness. Every other route
# is reported against it. It is also outside /api, so it is not rate limited (see
# UseSqlSimCityHttpSecurity), which is why it stays trustworthy through a long run.
$FloorRoute = '/healthz'

$DefaultRoutes = @(
    '/healthz'
    '/readyz'
    '/api/v1/deployment'
    '/api/v1/capabilities'
    '/api/v1/atlas'
    '/api/v1/atlas/status'
    '/api/v1/database-city'
    '/api/v1/query-store/status'
    '/api/v1/query-store/queries?pageSize=50'
    '/api/v1/findings/'
    '/api/v1/findings/status'
    '/api/v1/findings/export'
)

if (-not $Route -or $Route.Count -eq 0) { $Route = $DefaultRoutes }
if ($Route -notcontains $FloorRoute) { $Route = @($FloorRoute) + $Route }

# 429 is never an acceptable status, however the caller widened -ExpectStatus. A run that
# tolerated it would be reporting the rate limiter's rejection body as a measurement.
if ($ExpectStatus -contains 429) {
    throw '429 cannot be an expected status. It means the run measured the rate limiter, not the API.'
}

#region statistics

function Get-Percentile {
    param([double[]]$Values, [double]$P)
    if ($Values.Count -eq 0) { return $null }
    $sorted = @($Values | Sort-Object)
    $rank = [math]::Max(0, [math]::Ceiling(($P / 100) * $sorted.Count) - 1)
    return [double]$sorted[$rank]
}

function Get-Rounded {
    param($Value, [int]$Places = 2)
    if ($null -eq $Value) { return $null }
    return [math]::Round([double]$Value, $Places)
}

#endregion

#region API lifecycle

function Resolve-MeasureConnectionString {
    if ($ConnectionString) { return $ConnectionString }
    if ($env:ConnectionStrings__SqlSimCity) { return $env:ConnectionStrings__SqlSimCity }

    # The tools/measure rig, which is what Initialize-MeasureDatabase.ps1 prints at the end
    # of a seed. Encrypt=false is rejected outright by every profile, so the local
    # container's self-signed certificate needs TrustServerCertificate rather than
    # Encrypt=false.
    $readerPassword = if ($env:SQLSIMCITY_MEASURE_READER_PASSWORD) {
        $env:SQLSIMCITY_MEASURE_READER_PASSWORD
    } else { 'Reader!Local1' }
    return "Server=127.0.0.1,11433;Database=SimCityLoad;User Id=sqlsimcity_reader;" +
           "Password=$readerPassword;Encrypt=true;TrustServerCertificate=true"
}

function Publish-Api {
    param([string]$Directory)

    $marker = Join-Path $Directory 'SqlSimCity.Api.dll'
    if ((Test-Path $marker) -and -not $Rebuild) {
        Write-Host "Reusing the published API in $Directory (pass -Rebuild to republish)."
        return
    }

    # Release, always. `dotnet run` defaults to Debug, where the JIT skips inlining and
    # keeps every local alive -- a measurement taken there describes a build nobody runs.
    Write-Host 'Publishing the API (Release)...'
    & dotnet publish (Join-Path $repoRoot 'src/SqlSimCity.Api') -c Release -o $Directory --nologo -v quiet
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE." }
}

function Start-Api {
    param([string]$Directory, [string]$Connection, [string]$LogPath)

    $exe = if ($IsWindows) { 'SqlSimCity.Api.exe' } else { 'SqlSimCity.Api' }
    $exePath = Join-Path $Directory $exe
    if (-not (Test-Path $exePath)) { throw "Published API not found at $exePath." }

    $dataDirectory = Join-Path ([System.IO.Path]::GetTempPath()) 'sqlsimcity-measure-api-data'
    # The protected store persists between runs and keeps growing as the collector catches
    # up, and every route worth measuring here reads it. So a "before" run and an "after"
    # run taken back to back are not comparable unless both start from the same store --
    # the second is slower for reasons that have nothing to do with the change under test.
    if ($ResetStore -and (Test-Path $dataDirectory)) {
        Write-Host "Clearing the protected store in $dataDirectory."
        Remove-Item -Recurse -Force $dataDirectory
    }
    New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null

    # Set on this process so the child inherits, then restored immediately: the connection
    # string carries a password and has no reason to outlive the Start-Process call.
    $settings = [ordered]@{
        'ASPNETCORE_URLS'                 = "http://127.0.0.1:$Port"
        'ASPNETCORE_ENVIRONMENT'          = 'Production'
        'DOTNET_ENVIRONMENT'              = 'Production'
        'ConnectionStrings__SqlSimCity'   = $Connection
        'ProtectedStorage__DataDirectory' = $dataDirectory
        # The whole point of this block. The default is 600 per 60 seconds, which a
        # benchmark exhausts in seconds and then measures 429s.
        'HttpSecurity__ApiPermitLimit'    = "$ApiPermitLimit"
        'Logging__LogLevel__Default'      = 'Warning'
    }
    $saved = [ordered]@{}
    foreach ($key in $settings.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key)
        [Environment]::SetEnvironmentVariable($key, $settings[$key])
    }

    try {
        Write-Host "Starting the API on http://127.0.0.1:$Port (connected, ApiPermitLimit=$ApiPermitLimit)..."
        $process = Start-Process -FilePath $exePath -PassThru -NoNewWindow `
            -RedirectStandardOutput $LogPath -RedirectStandardError "$LogPath.err"
    }
    finally {
        foreach ($key in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($key, $saved[$key])
        }
    }
    return $process
}

function Stop-Api {
    param($Process)
    if ($null -eq $Process -or $Process.HasExited) { return }
    Write-Host 'Stopping the API...'
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    $Process.WaitForExit(15000) | Out-Null
}

function Get-ApiLogTail {
    param([string]$LogPath, [int]$Lines = 25)
    $text = @()
    foreach ($candidate in @($LogPath, "$LogPath.err")) {
        if (Test-Path $candidate) {
            $tail = Get-Content -LiteralPath $candidate -Tail $Lines -ErrorAction SilentlyContinue
            if ($tail) { $text += $tail }
        }
    }
    return ($text -join [Environment]::NewLine)
}

#endregion

#region HTTP

function New-MeasureClient {
    param([string]$Origin)
    $handler = [System.Net.Http.SocketsHttpHandler]::new()
    # Never auto-decompress. The encoded body is what a client waits for, and
    # AutomaticDecompression would both hide its size and fold decompression into the
    # measured time.
    $handler.AutomaticDecompression = [System.Net.DecompressionMethods]::None
    # One connection, reused. Establishing a connection per request would measure the
    # loopback stack rather than the route.
    $handler.MaxConnectionsPerServer = 1
    $handler.PooledConnectionLifetime = [TimeSpan]::FromMinutes(30)
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.BaseAddress = [Uri]$Origin
    $client.Timeout = [TimeSpan]::FromSeconds(180)
    return $client
}

function Get-DecodedLength {
    param([byte[]]$Bytes, [string]$Encoding)
    if ([string]::IsNullOrEmpty($Encoding) -or $Encoding -eq 'identity') { return $Bytes.Length }
    $source = [System.IO.MemoryStream]::new($Bytes)
    $sink = [System.IO.MemoryStream]::new()
    try {
        $decoder = switch ($Encoding) {
            'br'      { [System.IO.Compression.BrotliStream]::new($source, [System.IO.Compression.CompressionMode]::Decompress) }
            'gzip'    { [System.IO.Compression.GZipStream]::new($source, [System.IO.Compression.CompressionMode]::Decompress) }
            'deflate' { [System.IO.Compression.DeflateStream]::new($source, [System.IO.Compression.CompressionMode]::Decompress) }
            default   { $null }
        }
        if ($null -eq $decoder) { return $Bytes.Length }
        try { $decoder.CopyTo($sink) } finally { $decoder.Dispose() }
        return [int]$sink.Length
    }
    finally { $source.Dispose(); $sink.Dispose() }
}

function Invoke-MeasuredRequest {
    param($Client, [string]$Path, [string]$Encoding)

    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Path)
    $request.Headers.TryAddWithoutValidation('Accept-Encoding', $Encoding) | Out-Null
    $request.Headers.TryAddWithoutValidation('Accept', 'application/json') | Out-Null

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $response = $Client.SendAsync(
        $request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    try {
        $headersMs = $stopwatch.Elapsed.TotalMilliseconds
        $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        $stopwatch.Stop()

        $contentEncoding = @($response.Content.Headers.ContentEncoding) | Select-Object -First 1
        if ([string]::IsNullOrEmpty($contentEncoding)) { $contentEncoding = 'identity' }

        return [pscustomobject]@{
            Status          = [int]$response.StatusCode
            TotalMs         = $stopwatch.Elapsed.TotalMilliseconds
            HeadersMs       = $headersMs
            Bytes           = $bytes.Length
            DecodedBytes    = Get-DecodedLength -Bytes $bytes -Encoding $contentEncoding
            ContentEncoding = $contentEncoding
            Body            = $bytes
        }
    }
    finally { $response.Dispose(); $request.Dispose() }
}

function Assert-Status {
    param($Result, [string]$Path)
    if ($ExpectStatus -contains $Result.Status) { return }

    $preview = ''
    if ($Result.Body.Length -gt 0) {
        $preview = [System.Text.Encoding]::UTF8.GetString(
            $Result.Body, 0, [math]::Min(200, $Result.Body.Length))
    }

    if ($Result.Status -eq 429) {
        throw @"
$Path returned 429 (rate limited) after $($Result.Bytes) bytes: $preview

The run measured the rate limiter, not the API. HttpSecurity:ApiPermitLimit defaults to
600 requests per 60 seconds, and a benchmark exhausts that in seconds -- a loop that
ignores this reports 44-byte rejection bodies as if they were responses, which is exactly
what happened during #84.

Raise it on the server under test (this script applies -ApiPermitLimit when it starts the
API itself), or lower -Iterations.
"@
    }

    throw "$Path returned $($Result.Status), expected $($ExpectStatus -join ' or '). Body: $preview"
}

#endregion

#region readiness

function Wait-ApiReady {
    param($Client, $Process, [string]$LogPath)

    $deadline = (Get-Date).AddSeconds($ReadySeconds)
    while ((Get-Date) -lt $deadline) {
        if ($null -ne $Process -and $Process.HasExited) {
            throw "The API exited with code $($Process.ExitCode) before serving traffic.`n" +
                  (Get-ApiLogTail -LogPath $LogPath)
        }
        try {
            $probe = Invoke-MeasuredRequest -Client $Client -Path '/healthz' -Encoding 'identity'
            if ($probe.Status -eq 200) { return }
        }
        catch { }
        Start-Sleep -Milliseconds 500
    }
    throw "The API did not answer /healthz within $ReadySeconds seconds.`n" +
          (Get-ApiLogTail -LogPath $LogPath)
}

function Wait-CollectorReady {
    param($Client)

    # A connected API serves an empty evidence bundle until the first Atlas collection
    # lands, and an empty bundle makes /api/v1/findings/* cost almost nothing. Measuring
    # before this point produces fixture-shaped numbers from a connected server, which is
    # the failure this whole workbench exists to avoid.
    $deadline = (Get-Date).AddSeconds($ReadySeconds)
    $atlas = $null
    $lastReason = 'no status yet'
    while ((Get-Date) -lt $deadline) {
        try {
            $result = Invoke-MeasuredRequest -Client $Client -Path '/api/v1/atlas/status' -Encoding 'identity'
            Assert-Status -Result $result -Path '/api/v1/atlas/status'
            $status = [System.Text.Encoding]::UTF8.GetString($result.Body) | ConvertFrom-Json
            if ($status.lastCollectedAt -and $status.databaseCount -gt 0) {
                Write-Host ("Atlas collected {0} databases in {1} ms." -f
                    $status.databaseCount, $status.lastDurationMilliseconds)
                $atlas = $status
                break
            }
            $lastReason = "state=$($status.state) databases=$($status.databaseCount) reason=$($status.reason)"
        }
        catch {
            if ($_.Exception.Message -match '429') { throw }
            $lastReason = $_.Exception.Message
        }
        Start-Sleep -Seconds 2
    }
    if ($null -eq $atlas) {
        throw "Atlas did not complete a collection within $ReadySeconds seconds ($lastReason). " +
              'Measuring now would report an empty evidence bundle as if it were a connected one. ' +
              'Pass -SkipCollectorWait only if that is genuinely what you want to measure.'
    }

    # And the same again for Query Store, which is the slower half and the one that actually
    # costs anything. Every route worth measuring here reads the protected store, and the
    # store fills asynchronously: measuring while the collector is still publishing reports
    # a smaller history than the next run will see, which is how two runs of the same build
    # disagree by 40%.
    $lastReason = 'no status yet'
    while ((Get-Date) -lt $deadline) {
        try {
            $result = Invoke-MeasuredRequest -Client $Client -Path '/api/v1/query-store/status' -Encoding 'identity'
            Assert-Status -Result $result -Path '/api/v1/query-store/status'
            $status = [System.Text.Encoding]::UTF8.GetString($result.Body) | ConvertFrom-Json
            if ($status.state -in @('Disabled', 'Failed')) {
                throw "Query Store collection is $($status.state): $($status.reason). " +
                      'Every route worth measuring here reads what it collects.'
            }
            if ($status.state -in @('Ready', 'Partial') -and $status.lastPublishedAt) {
                Write-Host ("Query Store published at {0} ({1})." -f $status.lastPublishedAt, $status.state)
                return $atlas
            }
            $lastReason = "state=$($status.state) reason=$($status.reason)"
        }
        catch {
            if ($_.Exception.Message -match '429|Query Store collection is') { throw }
            $lastReason = $_.Exception.Message
        }
        Start-Sleep -Seconds 2
    }
    throw "Query Store did not publish within $ReadySeconds seconds ($lastReason)."
}

function Initialize-Pipeline {
    param($Client, [int]$Requests = 20)

    # Whatever is measured first pays for the whole pipeline: JIT for Kestrel's HTTP/1.1
    # parser, the security-header middleware, the response-compression middleware and the
    # Brotli encoder. The floor route is measured first by construction, so without this it
    # absorbs all of that and every other route reports a *negative* OverFloorMs -- observed
    # at -0.43 ms on the first run of this harness, which is the floor being wrong rather
    # than a route being faster than doing nothing.
    for ($i = 0; $i -lt $Requests; $i++) {
        foreach ($encoding in $AcceptEncoding) {
            $warm = Invoke-MeasuredRequest -Client $Client -Path $FloorRoute -Encoding $encoding
            Assert-Status -Result $warm -Path $FloorRoute
        }
    }
}

function Measure-Floor {
    param($Client, [string]$Encoding, [int]$Count)

    $times = @()
    for ($i = 0; $i -lt $Count; $i++) {
        $result = Invoke-MeasuredRequest -Client $Client -Path $FloorRoute -Encoding $Encoding
        Assert-Status -Result $result -Path $FloorRoute
        $times += $result.TotalMs
    }
    return Get-Percentile ([double[]]$times) 50
}

#endregion

#region rate-limit budget

function Assert-RateLimitBudget {
    param([string[]]$Routes, [int]$ReadinessPolls)

    # Only /api is rate limited: UseSqlSimCityHttpSecurity wraps the limiter in
    # UseWhen(path.StartsWithSegments("/api")), so /healthz and /readyz cost no permits.
    $apiRoutes = @($Routes | Where-Object { $_.StartsWith('/api') })
    $perRoute = $WarmUp + $Iterations
    $budget = ($apiRoutes.Count * $AcceptEncoding.Count * $perRoute) + $ReadinessPolls

    # Conservative on purpose: the window is ApiWindowSeconds (60 by default), so a run
    # longer than one window gets a fresh allowance this arithmetic does not count. Being
    # told to raise a limit that would have held is a cheaper mistake than measuring 429s.
    if ($budget -ge $ApiPermitLimit) {
        throw @"
This run would issue about $budget rate-limited requests against a limit of $ApiPermitLimit
per window, so some of it would measure 429 rejection bodies instead of responses.

Lower -Iterations, measure fewer routes, or raise -ApiPermitLimit (max 10000; the script
applies it when it starts the API itself, and only checks against it when -BaseUrl points
at a server you configured yourself).
"@
    }
    return $budget
}

#endregion

$publishDir = if ($PublishDirectory) { $PublishDirectory }
              else { Join-Path ([System.IO.Path]::GetTempPath()) 'sqlsimcity-measure-api' }
$logPath = Join-Path ([System.IO.Path]::GetTempPath()) 'sqlsimcity-measure-api.log'

$readinessPolls = [int][math]::Ceiling($ReadySeconds / 2) + 4
$budget = Assert-RateLimitBudget -Routes $Route -ReadinessPolls $readinessPolls

$process = $null
$client = $null
$startedHere = [string]::IsNullOrEmpty($BaseUrl)
$origin = if ($startedHere) { "http://127.0.0.1:$Port" } else { $BaseUrl.TrimEnd('/') }

try {
    if ($startedHere) {
        Publish-Api -Directory $publishDir
        $process = Start-Api -Directory $publishDir -Connection (Resolve-MeasureConnectionString) -LogPath $logPath
    }
    else {
        Write-Host "Measuring the API already running at $origin."
        Write-Host "Assuming HttpSecurity:ApiPermitLimit >= $ApiPermitLimit there; a 429 stops the run."
    }

    $client = New-MeasureClient -Origin $origin
    Wait-ApiReady -Client $client -Process $process -LogPath $logPath

    $atlasStatus = $null
    if (-not $SkipCollectorWait) { $atlasStatus = Wait-CollectorReady -Client $client }

    Initialize-Pipeline -Client $client

    $samples = @()
    $rows = @()
    foreach ($encoding in $AcceptEncoding) {
        foreach ($path in $Route) {
            Write-Host ("  {0,-45} {1}" -f $path, $encoding)

            # The warm-up is discarded, and it is not padding. The first request to a route
            # pays JIT for its handler and its serializer, and on the findings routes it
            # also pays for the first evidence bundle. Folding that into a median
            # attributes a one-off to every request.
            for ($i = 0; $i -lt $WarmUp; $i++) {
                $warm = Invoke-MeasuredRequest -Client $client -Path $path -Encoding $encoding
                Assert-Status -Result $warm -Path $path
            }

            $measured = @()
            for ($i = 0; $i -lt $Iterations; $i++) {
                $result = Invoke-MeasuredRequest -Client $client -Path $path -Encoding $encoding
                Assert-Status -Result $result -Path $path
                $measured += $result
                $samples += [pscustomobject]@{
                    Route     = $path
                    Accept    = $encoding
                    Iteration = $i
                    TotalMs   = Get-Rounded $result.TotalMs 3
                    HeadersMs = Get-Rounded $result.HeadersMs 3
                    Bytes     = $result.Bytes
                    Status    = $result.Status
                }
            }

            $times = [double[]]@($measured | ForEach-Object { $_.TotalMs })
            $ttfb = [double[]]@($measured | ForEach-Object { $_.HeadersMs })
            $rows += [pscustomobject]@{
                Route         = $path
                Accept        = $encoding
                N             = $measured.Count
                MedianMs      = Get-Rounded (Get-Percentile $times 50)
                TtfbMs        = Get-Rounded (Get-Percentile $ttfb 50)
                MinMs         = Get-Rounded (Get-Percentile $times 0)
                P95Ms         = Get-Rounded (Get-Percentile $times 95)
                MaxMs         = Get-Rounded (Get-Percentile $times 100)
                Encoding      = $measured[0].ContentEncoding
                Bytes         = $measured[0].Bytes
                IdentityBytes = $measured[0].DecodedBytes
                Status        = $measured[0].Status
                OverFloorMs   = $null
            }
        }
    }

    # Re-measure the floor after everything else. A floor that moved during the run is the
    # signal that something outside the harness did -- most often a background Atlas or
    # Query Store refresh landing mid-run, which is also what a wide P95 is showing.
    $floorDrift = @{}
    foreach ($encoding in $AcceptEncoding) {
        $before = @($rows | Where-Object { $_.Route -eq $FloorRoute -and $_.Accept -eq $encoding })[0].MedianMs
        $floorDrift[$encoding] = Get-Rounded ((Measure-Floor -Client $client -Encoding $encoding -Count $Iterations) - $before)
    }

    # OverFloorMs is the route's own cost. Computed per Accept-Encoding, because the floor
    # itself moves when the encoding does.
    foreach ($encoding in $AcceptEncoding) {
        $floor = @($rows | Where-Object { $_.Route -eq $FloorRoute -and $_.Accept -eq $encoding })[0]
        foreach ($row in @($rows | Where-Object { $_.Accept -eq $encoding })) {
            $row.OverFloorMs = Get-Rounded ($row.MedianMs - $floor.MedianMs)
        }
    }

    $report = [pscustomobject]@{
        Label                    = $Label
        MeasuredAt               = (Get-Date).ToString('o')
        Origin                   = $origin
        StartedByHarness         = $startedHere
        Mode                     = if ($startedHere) { 'Connected' } else { 'unknown (external server)' }
        ApiPermitLimit           = $ApiPermitLimit
        RateLimitedRequestBudget = $budget
        Iterations               = $Iterations
        WarmUp                   = $WarmUp
        FloorRoute               = $FloorRoute
        FloorDriftMs             = $floorDrift
        AtlasDatabases           = if ($atlasStatus) { $atlasStatus.databaseCount } else { $null }
        AtlasCollectionMs        = if ($atlasStatus) { $atlasStatus.lastDurationMilliseconds } else { $null }
        Routes                   = $rows
        Samples                  = $samples
    }

    Write-Host ''
    $rows |
        Format-Table Route, Accept, Encoding, N, MedianMs, OverFloorMs, TtfbMs, P95Ms, MaxMs, Bytes, IdentityBytes -AutoSize |
        Out-String -Width 220 |
        Write-Host
    foreach ($encoding in $AcceptEncoding) {
        Write-Host ("Floor ({0}, {1}): {2} ms, drifted {3} ms over the run." -f
            $FloorRoute, $encoding,
            @($rows | Where-Object { $_.Route -eq $FloorRoute -and $_.Accept -eq $encoding })[0].MedianMs,
            $floorDrift[$encoding])
    }

    if ($Json) {
        $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Json -Encoding UTF8
        Write-Host "Wrote $Json"
    }

    if ($KeepRunning -and $startedHere) {
        Write-Host "Leaving the API at $origin (PID $($process.Id)). Stop it with: Stop-Process -Id $($process.Id)"
        $process = $null
    }

    $report
}
finally {
    if ($client) { $client.Dispose() }
    Stop-Api -Process $process
}
