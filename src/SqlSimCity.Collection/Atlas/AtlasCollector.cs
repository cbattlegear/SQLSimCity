using System.Diagnostics;
using System.Globalization;
using System.Numerics;
using SqlSimCity.Collection.Negotiation;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.Atlas;

public sealed class AtlasCollector
{
    private readonly IAtlasProbeExecutor _executor;
    private readonly ILiveAtlasActivitySource _activity;
    private readonly AtlasCollectionOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly object _ioGate = new();
    private Dictionary<string, PreviousIoSample> _previousIo = [];
    private readonly object _queryStoreGate = new();
    private readonly Dictionary<string, RetainedQueryStore> _retainedQueryStore =
        new(StringComparer.OrdinalIgnoreCase);

    public AtlasCollector(
        IAtlasProbeExecutor executor,
        ILiveAtlasActivitySource activity,
        AtlasCollectionOptions options,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(executor);
        ArgumentNullException.ThrowIfNull(activity);
        ArgumentNullException.ThrowIfNull(options);
        options.Validate();
        _executor = executor;
        _activity = activity;
        _options = options;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async Task<AtlasCollectionResult> CollectAsync(long sequence, CancellationToken cancellationToken)
    {
        var started = _timeProvider.GetTimestamp();
        var collectedAt = _timeProvider.GetUtcNow();
        AtlasTargetIdentity target;
        IReadOnlyList<AtlasDatabaseIdentity> databases;
        try
        {
            target = await _executor.GetTargetIdentityAsync(cancellationToken).ConfigureAwait(false);
            databases = await SelectDatabasesAsync(target, cancellationToken).ConfigureAwait(false);
            if (databases.Count == 0)
                return Failed(sequence, collectedAt, started,
                    "Database discovery returned no visible databases; collection did not report empty success.");
        }
        catch (ProbeExecutionException ex)
        {
            return Failed(sequence, collectedAt, started, ex.Reason);
        }

        var selection = SelectProbes(target);
        var queryStoreDue = TakeQueryStoreDue(databases, collectedAt);
        using var concurrency = new SemaphoreSlim(_options.DatabaseConcurrency);
        var tasks = databases.Select((database, index) =>
            CollectOneBoundedAsync(
                database,
                index,
                target,
                queryStoreDue.Contains(database.Name)
                    ? selection
                    : selection with { QueryStoreWorkloadProbeId = null },
                collectedAt,
                concurrency,
                cancellationToken)).ToArray();
        var results = await Task.WhenAll(tasks).ConfigureAwait(false);
        Array.Sort(results, static (left, right) => left.Index.CompareTo(right.Index));

        var items = results.Select(result => result.Item).ToArray();
        var failures = results.Sum(result => result.FailureCount);
        var skips = results.Sum(result => result.SkipCount);
        var duration = (long)_timeProvider.GetElapsedTime(started).TotalMilliseconds;
        var state = failures > 0 ? AtlasCollectorState.Degraded : AtlasCollectorState.Ready;
        var reason = failures > 0
            ? $"{failures} database component collection(s) failed; successful evidence remains available."
            : "Connected atlas collection completed.";
        var staleAfter = collectedAt + _options.StaleAfter;
        var rowCount = results.Sum(result => (long)result.RowCount) + 1L +
                       (target.Platform == EnginePlatform.AzureSqlDatabase ? 0L : databases.Count);
        var metadata = new AtlasCollectionMetadataV1(
            AtlasCollectorMode.Connected, state, sequence, collectedAt, target.SourceTimestamp,
            staleAfter, false, items.Length, failures, skips, duration, reason)
        {
            RowCount = rowCount,
        };
        var snapshot = new AtlasSnapshotV1(
            "1.0",
            $"{_options.TargetId}/snapshot/{sequence.ToString(CultureInfo.InvariantCulture)}",
            new AtlasTargetV1(_options.TargetId, _options.DisplayName, PlatformName(target.Platform)),
            collectedAt,
            Array.AsReadOnly(items),
            [])
        {
            Collection = metadata,
        };
        var status = new AtlasCollectorStatusV1(
            AtlasCollectorMode.Connected, state, sequence, collectedAt, target.SourceTimestamp,
            staleAfter, false, items.Length, failures, skips, duration, 0, null, reason)
        {
            RowCount = rowCount,
        };
        return new AtlasCollectionResult(snapshot, status, false);
    }

    private async Task<IReadOnlyList<AtlasDatabaseIdentity>> SelectDatabasesAsync(
        AtlasTargetIdentity target,
        CancellationToken cancellationToken)
    {
        if (target.Platform == EnginePlatform.AzureSqlDatabase)
        {
            if (_options.KnownDatabases.Count == 0)
                throw new ProbeNotProbedException(
                    "Azure SQL Database requires an explicit known-database list; logical-server enumeration was not assumed.");

            return _options.KnownDatabases
                .Take(AtlasCollectionOptions.MaximumDatabases)
                .Select(name => new AtlasDatabaseIdentity(name, "UNKNOWN", 0, false))
                .ToArray();
        }

        return (await _executor.DiscoverDatabasesAsync(cancellationToken).ConfigureAwait(false))
            .Where(database => !string.IsNullOrWhiteSpace(database.Name))
            .Take(AtlasCollectionOptions.MaximumDatabases)
            .ToArray();
    }

    private async Task<IndexedResult> CollectOneBoundedAsync(
        AtlasDatabaseIdentity discovered,
        int index,
        AtlasTargetIdentity target,
        AtlasProbeSelection selection,
        DateTimeOffset collectedAt,
        SemaphoreSlim concurrency,
        CancellationToken cancellationToken)
    {
        await concurrency.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var result = await _executor.CollectDatabaseAsync(
                discovered.Name,
                selection,
                collectedAt - _options.QueryStoreWindow,
                collectedAt,
                cancellationToken).ConfigureAwait(false);
            var queryStore = ResolveQueryStore(discovered.Name, result.QueryStoreWorkload, collectedAt);
            result = result with { QueryStoreWorkload = queryStore.Workload };
            var identity = result.Identity;
            var databaseId = StableDatabaseId(identity);
            var activity = await _activity.GetActivityAsync(
                databaseId, identity.Name, collectedAt, cancellationToken).ConfigureAwait(false);
            return new IndexedResult(
                index,
                Project(databaseId, result, target, activity, collectedAt, queryStore.CollectedAt, queryStore.WasRetained),
                result.FailureCount,
                result.SkipCount,
                result.RowCount);
        }
        catch (ProbeNotProbedException ex)
        {
            ForgetQueryStore(discovered.Name);
            return new IndexedResult(index, Unavailable(discovered, collectedAt, ex.Reason, DataStatus.Unsupported), 0, 1, 0);
        }
        catch (ProbeExecutionException ex)
        {
            ForgetQueryStore(discovered.Name);
            var status = ex switch
            {
                ProbePermissionDeniedException => DataStatus.PermissionDenied,
                ProbeTransientConnectionException or ProbeDatabaseUnavailableException => DataStatus.Disconnected,
                _ => DataStatus.Unknown,
            };
            return new IndexedResult(index, Unavailable(discovered, collectedAt, ex.Reason, status), 1, 0, 0);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            ForgetQueryStore(discovered.Name);
            return new IndexedResult(index, Unavailable(discovered, collectedAt,
                "The database probe timed out.", DataStatus.Unknown), 1, 0, 0);
        }
        finally
        {
            concurrency.Release();
        }
    }

    /// <summary>
    /// The databases whose Query Store workload is collected this cycle: those never collected and
    /// those whose retained result has reached <see cref="AtlasCollectionOptions.QueryStoreRefreshInterval"/>.
    /// A database that is no longer discovered loses its retained result here, so if it comes back
    /// it is probed afresh rather than reported from a value collected before it went away.
    /// </summary>
    private HashSet<string> TakeQueryStoreDue(
        IReadOnlyList<AtlasDatabaseIdentity> databases,
        DateTimeOffset collectedAt)
    {
        var visible = new HashSet<string>(databases.Select(database => database.Name), StringComparer.OrdinalIgnoreCase);
        var due = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        lock (_queryStoreGate)
        {
            foreach (var gone in _retainedQueryStore.Keys.Where(name => !visible.Contains(name)).ToArray())
                _retainedQueryStore.Remove(gone);
            foreach (var name in visible)
            {
                if (!_retainedQueryStore.TryGetValue(name, out var retained))
                {
                    due.Add(name);
                    continue;
                }

                var age = collectedAt - retained.CollectedAt;
                if (age < TimeSpan.Zero || age >= _options.QueryStoreRefreshInterval)
                    due.Add(name);
            }
        }
        return due;
    }

    /// <summary>
    /// Reports the workload for this cycle together with the time it was actually collected, which
    /// is what its evidence is dated from. A retained result is only ever substituted for the
    /// deferral marker, so an unavailable, denied, disabled, or failed Query Store is reported as
    /// itself and drops the retained value instead of being masked by an older success.
    /// </summary>
    private ResolvedQueryStore ResolveQueryStore(
        string databaseName,
        AtlasComponentOutcome<AtlasQueryStoreWorkloadResult> workload,
        DateTimeOffset collectedAt)
    {
        lock (_queryStoreGate)
        {
            if (workload.IsDeferred)
                return _retainedQueryStore.TryGetValue(databaseName, out var retained)
                    ? new ResolvedQueryStore(retained.Workload, retained.CollectedAt, true)

                    // Nothing was retained to report, so the deferral has nothing to stand on.
                    // TakeQueryStoreDue only withholds the probe from a database that has one, so
                    // this says the component is unknown rather than inventing an empty history.
                    : new ResolvedQueryStore(
                        AtlasComponentOutcome.Skipped<AtlasQueryStoreWorkloadResult>(
                            DataStatus.Unknown,
                            "Query Store workload was deferred but no earlier collection was retained."),
                        collectedAt,
                        false);

            if (workload.IsSuccess)
            {
                _retainedQueryStore[databaseName] = new RetainedQueryStore(collectedAt, workload with
                {
                    RowCount = 0,
                    Reason = "Query Store workload retained from an earlier collection; no rows were read.",
                });
            }
            else
            {
                _retainedQueryStore.Remove(databaseName);
            }

            return new ResolvedQueryStore(workload, collectedAt, false);
        }
    }

    private void ForgetQueryStore(string databaseName)
    {
        lock (_queryStoreGate)
            _retainedQueryStore.Remove(databaseName);
    }

    private DatabaseAtlasItemV1 Project(
        string databaseId,
        AtlasDatabaseProbeResult result,
        AtlasTargetIdentity target,
        LiveActivityV1 activity,
        DateTimeOffset collectedAt,
        DateTimeOffset queryStoreCollectedAt,
        bool queryStoreRetained)
    {
        var source = result.SourceTimestamp;
        var spaceEvidence = ComponentEvidence(
            EvidenceSource.LiveDmvSample, result.Space, source, collectedAt,
            "Exact bytes collected from database-scoped catalog and DMV probes.");
        var unknownSpace = new ByteMeasurementV1(
            null, MeasurementStatus.Unknown, result.Space.Reason, spaceEvidence);
        var allocated = result.Space.Value is { } space
            ? KnownBytes(space.DataAllocatedBytes, spaceEvidence)
            : unknownSpace;
        var used = result.Space.Value is { } usedSpace
            ? KnownBytes(usedSpace.DataUsedBytes, spaceEvidence)
            : unknownSpace;
        var queryStore = SystemDatabases.IsSystemDatabase(result.Identity.Name)
            ? ExcludedQueryStore(result.Identity.Name, collectedAt, source)
            : ProjectQueryStore(
                result.QueryStoreOptions, result.QueryStoreWorkload, collectedAt, queryStoreCollectedAt,
                queryStoreRetained, source);
        return new DatabaseAtlasItemV1(
            databaseId,
            result.Identity.Name,
            allocated,
            used,
            activity,
            queryStore)
        {
            State = result.Identity.State,
            CompatibilityLevel = result.Identity.CompatibilityLevel,
            LogAllocated = result.Space.Value is { } logSpace
                ? KnownBytes(logSpace.LogAllocatedBytes, spaceEvidence)
                : unknownSpace,
            LogUsed = result.Space.Value is { } logUsed
                ? KnownBytes(logUsed.LogUsedBytes, spaceEvidence)
                : unknownSpace,
            FileIo = result.FileIo.Value is { } io
                ? ProjectIo(databaseId, io, target.SqlServerResetEpochToken, source, collectedAt)
                : UnavailableIo(result.FileIo, source, collectedAt),
        };
    }

    private QueryStoreHistoryV1 ExcludedQueryStore(
        string databaseName,
        DateTimeOffset collectedAt,
        DateTimeOffset source)
    {
        var reason = SystemDatabases.QueryStoreExclusionReason(databaseName);
        return new QueryStoreHistoryV1(
            null, null, null, null, null,
            QueryStoreCapability.Unsupported, QueryStoreHealth.Unavailable, reason,
            new EvidenceV1(
                EvidenceSource.NotProbed, DataStatus.Unsupported, source,
                collectedAt + _options.StaleAfter, reason));
    }

    private QueryStoreHistoryV1 ProjectQueryStore(
        AtlasComponentOutcome<AtlasQueryStoreOptionsResult> optionsOutcome,
        AtlasComponentOutcome<AtlasQueryStoreWorkloadResult> workloadOutcome,
        DateTimeOffset collectedAt,
        DateTimeOffset queryStoreCollectedAt,
        bool queryStoreRetained,
        DateTimeOffset source)
    {
        if (optionsOutcome.Value is not { } options)
        {
            var unavailableCapability = optionsOutcome.Status switch
            {
                DataStatus.PermissionDenied => QueryStoreCapability.PermissionDenied,
                DataStatus.Unsupported => QueryStoreCapability.Unsupported,
                _ => QueryStoreCapability.Unknown,
            };
            var unavailableEvidence = ComponentEvidence(
                EvidenceSource.QueryStoreAggregate, optionsOutcome, source, collectedAt,
                optionsOutcome.Reason);
            return new QueryStoreHistoryV1(
                null, null, null, null, null, unavailableCapability, QueryStoreHealth.Unavailable,
                optionsOutcome.Reason, unavailableEvidence);
        }

        var value = workloadOutcome.Value;
        var state = options.ActualState.ToUpperInvariant();
        var (capability, health, status, reason) = state switch
        {
            "ON" or "READ_WRITE" => (QueryStoreCapability.Available, QueryStoreHealth.Healthy, DataStatus.Available,
                "Query Store is readable and collecting."),
            "READ_ONLY" => (QueryStoreCapability.Available, QueryStoreHealth.ReadOnly, DataStatus.Available,
                QueryStoreReadOnlyReason.Describe(options.ReadOnlyReason)),
            "READ_CAPTURE_SECONDARY" => (QueryStoreCapability.Available, QueryStoreHealth.ReadableSecondary,
                DataStatus.Available, "Query Store is readable on a secondary replica and captures secondary workload."),
            "OFF" => (QueryStoreCapability.Disabled, QueryStoreHealth.Unavailable, DataStatus.Disabled,
                "Query Store is OFF for this database."),
            "ERROR" => (QueryStoreCapability.Available, QueryStoreHealth.Error, DataStatus.Unknown,
                "Query Store reports ERROR and its workload history is unavailable."),
            _ => (QueryStoreCapability.Unknown, QueryStoreHealth.Unknown, DataStatus.Unknown,
                "Query Store returned an unrecognized operational state."),
        };
        if (value is null && workloadOutcome.IsFailure && capability == QueryStoreCapability.Available)
        {
            status = workloadOutcome.Status;
            reason = $"{reason} Workload history failed: {workloadOutcome.Reason}";
        }
        else if (queryStoreRetained && value is not null)
        {
            reason = $"{reason} Workload history is unchanged from an earlier Query Store collection " +
                     "on its own refresh interval; its window and observation time are those of that collection.";
        }

        // The window end is the observation, and it stays the one the aggregate was actually taken
        // over. A retained result is dated from the cycle that collected it, never from this one:
        // restamping it would report evidence as fresher than it is.
        var evidence = new EvidenceV1(
            EvidenceSource.QueryStoreAggregate, status, value?.WindowEnd ?? source,
            queryStoreCollectedAt + _options.StaleAfter, reason);
        var count = capability == QueryStoreCapability.Available ? value?.ExecutionCount : null;
        return new QueryStoreHistoryV1(
            count,
            capability == QueryStoreCapability.Available ? value?.LogicalReads8KiBPages : null,
            WeightedAverage(value?.TotalDurationMicroseconds, count),
            value?.WindowStart,
            value?.WindowEnd,
            capability,
            health,
            reason,
            evidence)
        {
            TotalDurationMicroseconds = capability == QueryStoreCapability.Available ? value?.TotalDurationMicroseconds : null,
            TotalCpuMicroseconds = capability == QueryStoreCapability.Available ? value?.TotalCpuMicroseconds : null,
            DesiredState = options.DesiredState,
            CaptureMode = options.CaptureMode,
            CurrentStorageBytes = options.CurrentStorageBytes,
            MaxStorageBytes = options.MaxStorageBytes,
            AbortedExecutionCount = value?.AbortedExecutionCount,
            ExceptionExecutionCount = value?.ExceptionExecutionCount,
        };
    }

    private FileIoV1 ProjectIo(
        string databaseId,
        IReadOnlyList<AtlasFileIoCounter> counters,
        string? resetEpoch,
        DateTimeOffset source,
        DateTimeOffset collectedAt)
    {
        var files = counters.ToDictionary(
            counter => counter.FileId,
            counter => new FileCounters(ParseUnsigned(counter.BytesRead), ParseUnsigned(counter.BytesWritten)));
        var bytesRead = files.Values.Aggregate(BigInteger.Zero, (sum, counter) => sum + counter.BytesRead);
        var bytesWritten = files.Values.Aggregate(BigInteger.Zero, (sum, counter) => sum + counter.BytesWritten);
        var sampleMs = counters.Count == 0 ? 0 : counters.Max(counter => counter.SampleMilliseconds);
        string? readRate = null;
        string? writeRate = null;
        var reason = "Cumulative file I/O counters collected; a second comparable sample is required before rates are available.";

        lock (_ioGate)
        {
            if (_previousIo.TryGetValue(databaseId, out var previous) &&
                previous.ResetEpoch == resetEpoch &&
                sampleMs > previous.SampleMilliseconds &&
                files.Count == previous.Files.Count &&
                files.All(file => previous.Files.TryGetValue(file.Key, out var old) &&
                                  file.Value.BytesRead >= old.BytesRead &&
                                  file.Value.BytesWritten >= old.BytesWritten))
            {
                var elapsedMs = sampleMs - previous.SampleMilliseconds;
                var readDelta = files.Aggregate(BigInteger.Zero,
                    (sum, file) => sum + file.Value.BytesRead - previous.Files[file.Key].BytesRead);
                var writeDelta = files.Aggregate(BigInteger.Zero,
                    (sum, file) => sum + file.Value.BytesWritten - previous.Files[file.Key].BytesWritten);
                readRate = (readDelta * 1000 / elapsedMs).ToString(CultureInfo.InvariantCulture);
                writeRate = (writeDelta * 1000 / elapsedMs).ToString(CultureInfo.InvariantCulture);
                reason = "Rates are deltas between two comparable cumulative samples in the same SQL Server reset epoch.";
            }
            else if (_previousIo.ContainsKey(databaseId))
            {
                reason = "Cumulative counters reset or regressed; this sample establishes a new baseline and has no rate.";
            }

            _previousIo[databaseId] = new PreviousIoSample(files, sampleMs, resetEpoch);
        }

        return new FileIoV1(
            bytesRead.ToString(CultureInfo.InvariantCulture),
            bytesWritten.ToString(CultureInfo.InvariantCulture),
            readRate,
            writeRate,
            sampleMs.ToString(CultureInfo.InvariantCulture),
            resetEpoch,
            new EvidenceV1(EvidenceSource.LiveDmvCumulative, DataStatus.Available, source,
                collectedAt + _options.StaleAfter, reason));
    }

    private FileIoV1 UnavailableIo(
        AtlasComponentOutcome<IReadOnlyList<AtlasFileIoCounter>> outcome,
        DateTimeOffset source,
        DateTimeOffset collectedAt) => new(
        null, null, null, null, null, null,
        ComponentEvidence(EvidenceSource.LiveDmvCumulative, outcome, source, collectedAt, outcome.Reason));

    private EvidenceV1 ComponentEvidence<T>(
        EvidenceSource evidenceSource,
        AtlasComponentOutcome<T> outcome,
        DateTimeOffset source,
        DateTimeOffset collectedAt,
        string successReason) => new(
        evidenceSource,
        outcome.Status,
        outcome.IsSuccess ? source : null,
        outcome.IsSuccess ? collectedAt + _options.StaleAfter : null,
        outcome.IsSuccess ? successReason : outcome.Reason);

    private DatabaseAtlasItemV1 Unavailable(
        AtlasDatabaseIdentity database,
        DateTimeOffset collectedAt,
        string reason,
        DataStatus status)
    {
        var evidence = new EvidenceV1(EvidenceSource.NotProbed, status, null, null, reason);
        var bytes = new ByteMeasurementV1(null, MeasurementStatus.Unknown, reason, evidence);
        return new DatabaseAtlasItemV1(
            StableDatabaseId(database), database.Name, bytes, bytes,
            new LiveActivityV1(null, null, null, null, evidence),
            new QueryStoreHistoryV1(null, null, null, null, null,
                QueryStoreCapability.Unknown, QueryStoreHealth.Unavailable, reason, evidence))
        {
            State = database.State,
            CompatibilityLevel = database.CompatibilityLevel == 0 ? null : database.CompatibilityLevel,
            LogAllocated = bytes,
            LogUsed = bytes,
        };
    }

    private AtlasCollectionResult Failed(long sequence, DateTimeOffset collectedAt, long started, string reason)
    {
        var duration = (long)_timeProvider.GetElapsedTime(started).TotalMilliseconds;
        var snapshot = new AtlasSnapshotV1(
            "1.0", $"{_options.TargetId}/failed/{sequence}", new AtlasTargetV1(_options.TargetId, _options.DisplayName, "Unknown"),
            collectedAt, [], [])
        {
            Collection = new AtlasCollectionMetadataV1(
                AtlasCollectorMode.Connected, AtlasCollectorState.Disconnected, sequence, collectedAt, null,
                null, true, 0, 1, 0, duration, reason),
        };
        var status = new AtlasCollectorStatusV1(
            AtlasCollectorMode.Connected, AtlasCollectorState.Disconnected, sequence, null, null, null,
            true, 0, 1, 0, duration, 1, null, reason);
        return new AtlasCollectionResult(snapshot, status, true);
    }

    public static AtlasProbeSelection SelectProbes(AtlasTargetIdentity target)
    {
        var majorText = target.ProductVersion.Split('.', 2)[0];
        if (!int.TryParse(majorText, NumberStyles.None, CultureInfo.InvariantCulture, out var major))
            throw new InvalidOperationException("The negotiated product version has no valid major version.");
        var modern = target.Platform == EnginePlatform.AzureSqlDatabase || major >= 16;
        return new AtlasProbeSelection(
            target.Platform == EnginePlatform.AzureSqlDatabase || major >= 15
                ? "querystore.options_2019"
                : "querystore.options_2016",
            modern ? "querystore.database_workload_summary_2022" : "querystore.database_workload_summary_2016",
            "io.file_io_stats_current_db");
    }

    private string StableDatabaseId(AtlasDatabaseIdentity database) =>
        database.ResourceIdentity is { Length: > 0 } resource
            ? $"{_options.TargetId}/resource/{Uri.EscapeDataString(resource)}"
            : $"{_options.TargetId}/database/{Uri.EscapeDataString(database.Name)}";

    private static ByteMeasurementV1 KnownBytes(string bytes, EvidenceV1 evidence)
    {
        _ = ParseUnsigned(bytes);
        return new ByteMeasurementV1(bytes, MeasurementStatus.Known, null, evidence);
    }

    private static decimal? WeightedAverage(string? total, string? count)
    {
        if (total is null || count is null || !decimal.TryParse(total, NumberStyles.Number, CultureInfo.InvariantCulture, out var totalValue) ||
            !decimal.TryParse(count, NumberStyles.None, CultureInfo.InvariantCulture, out var countValue) || countValue == 0)
            return null;
        return totalValue / countValue;
    }

    private static BigInteger ParseUnsigned(string value)
    {
        if (!BigInteger.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) || parsed < 0)
            throw new InvalidOperationException("A probe returned an invalid unsigned decimal value.");
        return parsed;
    }

    private static string PlatformName(EnginePlatform platform) => platform switch
    {
        EnginePlatform.SqlServerOnPremises => "SQL Server",
        EnginePlatform.AzureSqlDatabase => "Azure SQL Database",
        EnginePlatform.AzureSqlManagedInstance => "Azure SQL Managed Instance",
        _ => "Unsupported",
    };

    private sealed record IndexedResult(
        int Index,
        DatabaseAtlasItemV1 Item,
        int FailureCount,
        int SkipCount,
        int RowCount);
    private sealed record FileCounters(BigInteger BytesRead, BigInteger BytesWritten);
    private sealed record RetainedQueryStore(
        DateTimeOffset CollectedAt,
        AtlasComponentOutcome<AtlasQueryStoreWorkloadResult> Workload);
    private sealed record ResolvedQueryStore(
        AtlasComponentOutcome<AtlasQueryStoreWorkloadResult> Workload,
        DateTimeOffset CollectedAt,
        bool WasRetained);
    private sealed record PreviousIoSample(
        IReadOnlyDictionary<int, FileCounters> Files,
        long SampleMilliseconds,
        string? ResetEpoch);
}
