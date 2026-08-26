using SqlSimCity.Collection.Atlas;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using System.Globalization;
using System.Numerics;

namespace SqlSimCity.Collection.Tests.Atlas;

public sealed class AtlasCollectorTests
{
    [Fact]
    public void RejectsDatabaseAndConcurrencyLimitsAboveHardMaximum()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new AtlasCollectionOptions
        {
            KnownDatabases = Enumerable.Range(0, 101).Select(index => $"db-{index}").ToArray(),
        }.Validate());
        Assert.Throws<ArgumentOutOfRangeException>(() => new AtlasCollectionOptions
        {
            DatabaseConcurrency = 17,
        }.Validate());
    }

    [Fact]
    public async Task CollectsOneHundredWithBoundedConcurrencyAndPartialFailure()
    {
        var executor = new FakeExecutor
        {
            Databases = Enumerable.Range(1, 100)
                .Select(index => new AtlasDatabaseIdentity($"db-{index}", "ONLINE", 160, true))
                .ToArray(),
            Result = name => name switch
            {
                "db-42" => throw new ProbePermissionDeniedException("Database permission denied.", 229, 14),
                "db-43" => throw new ProbeTimeoutException("Database probe timed out.", -2, 11),
                _ => DatabaseResult(name),
            },
            Delay = TimeSpan.FromMilliseconds(5),
        };
        var collector = Collector(executor, new AtlasCollectionOptions { DatabaseConcurrency = 5 });

        var result = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(100, result.Snapshot.Databases.Count);
        Assert.Equal(2, result.Status.FailureCount);
        Assert.Equal(AtlasCollectorState.Degraded, result.Status.State);
        Assert.True(result.Status.RowCount > 0);
        Assert.InRange(executor.MaximumActive, 2, 5);
        Assert.Equal(DataStatus.PermissionDenied,
            result.Snapshot.Databases.Single(database => database.Name == "db-42").Allocated.Evidence.Status);
        var exact = result.Snapshot.Databases.Single(database => database.Name == "db-1");
        Assert.Equal("9007199254740993", exact.Allocated.Bytes);
        Assert.Equal("27021597764222979", exact.QueryStore.TotalDurationMicroseconds);
        Assert.Equal("9007199254740993", exact.QueryStore.ExecutionCount);
        Assert.All(executor.Selections, request =>
            Assert.Equal("querystore.database_workload_summary_2022", request.Selection.QueryStoreWorkloadProbeId));
        Assert.All(executor.Selections, request =>
            Assert.Equal("io.file_io_stats_current_db", request.Selection.FileIoProbeId));
    }

    [Fact]
    public async Task AzureUsesOnlyConfiguredKnownDatabaseListAndCurrentDatabaseIo()
    {
        var executor = new FakeExecutor
        {
            Target = Target(EnginePlatform.AzureSqlDatabase),
            Result = DatabaseResult,
        };
        var options = new AtlasCollectionOptions
        {
            KnownDatabases = ["sales", "warehouse"],
            DatabaseConcurrency = 2,
        };

        var result = await Collector(executor, options).CollectAsync(1, CancellationToken.None);

        Assert.Equal(["sales", "warehouse"], result.Snapshot.Databases.Select(database => database.Name));
        Assert.Equal(0, executor.DiscoveryCalls);
        Assert.All(executor.Selections, request =>
            Assert.Equal("io.file_io_stats_current_db", request.Selection.FileIoProbeId));
        Assert.All(result.Snapshot.Databases, database =>
            Assert.StartsWith("primary/database/", database.DatabaseId, StringComparison.Ordinal));
    }

    [Fact]
    public async Task IoRatesRequireComparableSecondSampleAndResetEpoch()
    {
        var bytes = 100L;
        var sample = 1_000L;
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
            Result = name => DatabaseResult(name) with
            {
                FileIo = AtlasComponentOutcome.Success<IReadOnlyList<AtlasFileIoCounter>>(
                    [new AtlasFileIoCounter(1, bytes.ToString(CultureInfo.InvariantCulture), (bytes * 2).ToString(CultureInfo.InvariantCulture), sample)],
                    1,
                    "I/O available."),
            },
        };
        var collector = Collector(executor);

        var first = await collector.CollectAsync(1, CancellationToken.None);
        bytes = 1_100;
        sample = 2_000;
        var second = await collector.CollectAsync(2, CancellationToken.None);
        executor.Target = executor.Target with { SqlServerResetEpochToken = "sqlserver-local:2026-08-17T12:01:00" };
        bytes = 2_100;
        sample = 3_000;
        var reset = await collector.CollectAsync(3, CancellationToken.None);

        Assert.Null(first.Snapshot.Databases[0].FileIo!.ReadBytesPerSecond);
        Assert.Equal("1000", second.Snapshot.Databases[0].FileIo!.ReadBytesPerSecond);
        Assert.Null(reset.Snapshot.Databases[0].FileIo!.ReadBytesPerSecond);
        Assert.Contains("reset", reset.Snapshot.Databases[0].FileIo!.Evidence.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("OFF", QueryStoreCapability.Disabled, QueryStoreHealth.Unavailable)]
    [InlineData("READ_ONLY", QueryStoreCapability.Available, QueryStoreHealth.ReadOnly)]
    [InlineData("ERROR", QueryStoreCapability.Available, QueryStoreHealth.Error)]
    public async Task ProjectsQueryStoreOperationalReason(
        string state,
        QueryStoreCapability capability,
        QueryStoreHealth health)
    {
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
            Result = name => DatabaseResult(name) with
            {
                QueryStoreOptions = AtlasComponentOutcome.Success(
                    DatabaseResult(name).QueryStoreOptions.Value! with { ActualState = state, ReadOnlyReason = 65536 },
                    1,
                    "Options available."),
            },
        };

        var result = await Collector(executor).CollectAsync(1, CancellationToken.None);

        Assert.Equal(capability, result.Snapshot.Databases[0].QueryStore.Capability);
        Assert.Equal(health, result.Snapshot.Databases[0].QueryStore.Health);
        if (state == "READ_ONLY")
            Assert.Contains("max_storage_size_mb", result.Snapshot.Databases[0].QueryStore.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SystemDatabaseQueryStoreIsExcludedInsteadOfCollectedOrDegraded()
    {
        var executor = new FakeExecutor
        {
            Databases =
            [
                new AtlasDatabaseIdentity("master", "ONLINE", 160, false),
                new AtlasDatabaseIdentity("sales", "ONLINE", 160, true),
            ],
            Result = name => name switch
            {
                "master" => DatabaseResult(name) with
                {
                    QueryStoreOptions = AtlasComponentOutcome.Failure<AtlasQueryStoreOptionsResult>(
                        DataStatus.Unknown, "The Query Store options probe returned no row."),
                    QueryStoreWorkload = AtlasComponentOutcome.Skipped<AtlasQueryStoreWorkloadResult>(
                        DataStatus.Unknown, "Workload depends on options."),
                },
                _ => DatabaseResult(name),
            },
        };

        var result = await Collector(executor).CollectAsync(1, CancellationToken.None);
        var master = result.Snapshot.Databases.Single(database => database.Name == "master");

        Assert.Equal(QueryStoreCapability.Unsupported, master.QueryStore.Capability);
        Assert.Equal(QueryStoreHealth.Unavailable, master.QueryStore.Health);
        Assert.Equal(EvidenceSource.NotProbed, master.QueryStore.Evidence.Source);
        Assert.Equal(DataStatus.Unsupported, master.QueryStore.Evidence.Status);
        Assert.Null(master.QueryStore.ExecutionCount);
        Assert.Contains("system database", master.QueryStore.Reason, StringComparison.Ordinal);
        Assert.Equal("9007199254740993", master.Allocated.Bytes);
        Assert.Equal(QueryStoreCapability.Available,
            result.Snapshot.Databases.Single(database => database.Name == "sales").QueryStore.Capability);
        Assert.Equal(0, result.Status.FailureCount);
        Assert.Equal(AtlasCollectorState.Ready, result.Status.State);
    }

    [Fact]
    public async Task PreservesStorageAndIoWhenQueryStoreOptionsAreDenied()
    {
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
            Result = name => DatabaseResult(name) with
            {
                QueryStoreOptions = AtlasComponentOutcome.Failure<AtlasQueryStoreOptionsResult>(
                    DataStatus.PermissionDenied,
                    "Query Store options permission denied."),
                QueryStoreWorkload = AtlasComponentOutcome.Skipped<AtlasQueryStoreWorkloadResult>(
                    DataStatus.PermissionDenied,
                    "Workload depends on options."),
            },
        };

        var result = await Collector(executor).CollectAsync(1, CancellationToken.None);
        var database = Assert.Single(result.Snapshot.Databases);

        Assert.Equal("9007199254740993", database.Allocated.Bytes);
        Assert.Equal("100", database.FileIo!.BytesRead);
        Assert.Equal(QueryStoreCapability.PermissionDenied, database.QueryStore.Capability);
        Assert.Null(database.QueryStore.ExecutionCount);
        Assert.Equal(1, result.Status.FailureCount);
        Assert.Equal(1, result.Status.SkipCount);
        Assert.Equal(AtlasCollectorState.Degraded, result.Status.State);
    }

    [Fact]
    public async Task PreservesQueryStoreStateWhenHistoryAndIoFail()
    {
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
            Result = name => DatabaseResult(name) with
            {
                QueryStoreWorkload = AtlasComponentOutcome.Failure<AtlasQueryStoreWorkloadResult>(
                    DataStatus.Unknown,
                    "Query Store workload timed out."),
                FileIo = AtlasComponentOutcome.Failure<IReadOnlyList<AtlasFileIoCounter>>(
                    DataStatus.PermissionDenied,
                    "I/O permission denied."),
            },
        };

        var result = await Collector(executor).CollectAsync(1, CancellationToken.None);
        var database = Assert.Single(result.Snapshot.Databases);

        Assert.Equal("9007199254740993", database.Allocated.Bytes);
        Assert.Equal(QueryStoreCapability.Available, database.QueryStore.Capability);
        Assert.Equal(QueryStoreHealth.Healthy, database.QueryStore.Health);
        Assert.Contains("Workload history failed", database.QueryStore.Reason, StringComparison.Ordinal);
        Assert.Null(database.QueryStore.ExecutionCount);
        Assert.Null(database.FileIo!.BytesRead);
        Assert.Equal(DataStatus.PermissionDenied, database.FileIo.Evidence.Status);
        Assert.Equal(2, result.Status.FailureCount);
    }

    [Fact]
    public async Task ReadableSecondaryKeepsRegularWorkloadSeparateFromFailures()
    {
        var workload = new AtlasQueryStoreWorkloadResult(
            "10", "10000", "2000", "3000",
            ParseDate("2026-08-16T13:00:00Z"), ParseDate("2026-08-17T13:00:00Z"))
        {
            AbortedExecutionCount = "9000",
            ExceptionExecutionCount = "7",
        };
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
            Result = name => DatabaseResult(name) with
            {
                QueryStoreOptions = AtlasComponentOutcome.Success(
                    new AtlasQueryStoreOptionsResult("READ_CAPTURE_SECONDARY", 0),
                    1,
                    "Options available."),
                QueryStoreWorkload = AtlasComponentOutcome.Success(workload, 3, "Workload available."),
            },
        };

        var result = await Collector(executor).CollectAsync(1, CancellationToken.None);
        var queryStore = Assert.Single(result.Snapshot.Databases).QueryStore;

        Assert.Equal(QueryStoreHealth.ReadableSecondary, queryStore.Health);
        Assert.Equal(1000m, queryStore.AverageDurationMicroseconds);
        Assert.Equal("10", queryStore.ExecutionCount);
        Assert.Equal("9000", queryStore.AbortedExecutionCount);
        Assert.Equal("7", queryStore.ExceptionExecutionCount);
    }

    [Fact]
    public async Task RefreshPreventsOverlapSupportsPauseAndBacksOff()
    {
        var executor = new FakeExecutor
        {
            IdentityFailure = new ProbeTransientConnectionException("Target unavailable.", 40613, 20),
        };
        var options = new AtlasCollectionOptions();
        var coordinator = new AtlasRefreshCoordinator(
            Collector(executor, options), options,
            new ExponentialReconnectBackoff(TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(1), new FixedJitter()),
            TimeProvider.System);

        var first = await coordinator.TryRefreshAsync(CancellationToken.None);
        var status = coordinator.GetStatus();
        coordinator.Pause();
        var paused = await coordinator.TryRefreshAsync(CancellationToken.None);
        coordinator.Resume();

        Assert.True(first);
        Assert.False(paused);
        Assert.Equal(AtlasCollectorState.BackingOff, status.State);
        Assert.Equal(1, status.ConsecutiveFailures);
        Assert.NotNull(status.NextAttemptAt);
        Assert.Equal(1, coordinator.GetStatus().SkipCount);
    }

    [Fact]
    public async Task RefreshRejectsOverlappingCycle()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
            Block = release.Task,
            Entered = entered,
        };
        var options = new AtlasCollectionOptions();
        using var coordinator = new AtlasRefreshCoordinator(
            Collector(executor, options), options,
            new ExponentialReconnectBackoff(TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(1), new FixedJitter()));

        var first = coordinator.TryRefreshAsync(CancellationToken.None);
        await entered.Task;
        var overlapping = await coordinator.TryRefreshAsync(CancellationToken.None);
        release.SetResult();

        Assert.False(overlapping);
        Assert.True(await first);
        Assert.Equal(1, coordinator.GetStatus().SkipCount);
        Assert.True(await coordinator.TryRefreshAsync(CancellationToken.None));
        Assert.Equal(0, coordinator.GetStatus().SkipCount);
    }

    [Theory]
    [InlineData("13.0.1", "querystore.options_2016", "querystore.database_workload_summary_2016")]
    [InlineData("15.0.1", "querystore.options_2019", "querystore.database_workload_summary_2016")]
    [InlineData("16.0.1", "querystore.options_2019", "querystore.database_workload_summary_2022")]
    public void ProbeVariantsFollowNegotiatedMajorVersion(string version, string options, string runtime)
    {
        var selection = AtlasCollector.SelectProbes(Target() with { ProductVersion = version });

        Assert.Equal(options, selection.QueryStoreOptionsProbeId);
        Assert.Equal(runtime, selection.QueryStoreWorkloadProbeId);
    }

    [Fact]
    public async Task RefreshStatusBecomesStaleFromInjectedClock()
    {
        var clock = new ManualTimeProvider(ParseDate("2026-08-17T13:00:00Z"));
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
        };
        var options = new AtlasCollectionOptions
        {
            RefreshInterval = TimeSpan.FromSeconds(10),
            StaleAfter = TimeSpan.FromSeconds(20),
        };
        using var coordinator = new AtlasRefreshCoordinator(
            Collector(executor, options, clock), options,
            new ExponentialReconnectBackoff(TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(1), new FixedJitter()),
            clock);

        await coordinator.TryRefreshAsync(CancellationToken.None);
        Assert.False(coordinator.GetStatus().IsStale);
        clock.Advance(TimeSpan.FromSeconds(21));

        Assert.True(coordinator.GetStatus().IsStale);
        Assert.True(coordinator.GetCurrent().Collection!.IsStale);
    }

    [Fact]
    public void PendingConnectedMetadataUsesUnavailableTimestamps()
    {
        var options = new AtlasCollectionOptions();
        using var coordinator = new AtlasRefreshCoordinator(
            Collector(new FakeExecutor(), options),
            options,
            new ExponentialReconnectBackoff(TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(1), new FixedJitter()));

        var metadata = coordinator.GetCurrent().Collection!;

        Assert.Null(metadata.CollectedAt);
        Assert.Null(metadata.SourceTimestamp);
    }

    [Fact]
    public async Task ActivitySeamSeparatesFixtureValuesFromConnectedNotProbed()
    {
        var fixtureValue = new LiveActivityV1(4, 2, 1, 10,
            new EvidenceV1(EvidenceSource.Fixture, DataStatus.Available, null, null, "fixture"));
        var fixture = new FixtureLiveAtlasActivitySource(
            new Dictionary<string, LiveActivityV1> { ["target/database/db"] = fixtureValue });
        var connected = new NotProbedLiveAtlasActivitySource();

        var fromFixture = await fixture.GetActivityAsync(
            "target/database/db", "db", DateTimeOffset.UnixEpoch, CancellationToken.None);
        var fromConnected = await connected.GetActivityAsync(
            "target/database/db", "db", DateTimeOffset.UnixEpoch, CancellationToken.None);

        Assert.Equal(4, fromFixture.ActiveSessions);
        Assert.Equal(EvidenceSource.Fixture, fromFixture.Evidence.Source);
        Assert.Null(fromConnected.ActiveSessions);
        Assert.Equal(EvidenceSource.NotProbed, fromConnected.Evidence.Source);
    }

    [Fact]
    public void AggregatesExactDataAndLogBytesAcrossFiles()
    {
        var result = SqlClientAtlasProbeExecutor.AggregateSpace(
            [
                new DatabaseFileSpaceValue("ROWS", BigInteger.Parse("9007199254740993", CultureInfo.InvariantCulture), new BigInteger(10)),
                new DatabaseFileSpaceValue("ROWS", new BigInteger(7), new BigInteger(5)),
                new DatabaseFileSpaceValue("LOG", new BigInteger(99), null),
            ],
            new BigInteger(99),
            new BigInteger(44));

        Assert.Equal("9007199254741000", result.DataAllocatedBytes);
        Assert.Equal("15", result.DataUsedBytes);
        Assert.Equal("99", result.LogAllocatedBytes);
        Assert.Equal("44", result.LogUsedBytes);
    }

    [Fact]
    public void QueryStoreAggregateUsesOnlyRegularRowsForSteadyStateTotals()
    {
        var result = SqlClientAtlasProbeExecutor.AggregateWorkload(
        [
            new AtlasQueryStoreAggregateRow(0, new BigInteger(10), new BigInteger(10_000), new BigInteger(2_000), new BigInteger(3_000)),
            new AtlasQueryStoreAggregateRow(3, new BigInteger(9_000), new BigInteger(9_000), new BigInteger(9_000), new BigInteger(9_000)),
            new AtlasQueryStoreAggregateRow(4, new BigInteger(7), new BigInteger(7), new BigInteger(7), new BigInteger(7)),
        ],
        ParseDate("2026-08-16T13:00:00Z"),
        ParseDate("2026-08-17T13:00:00Z"));

        Assert.Equal("10", result.ExecutionCount);
        Assert.Equal("10000", result.TotalDurationMicroseconds);
        Assert.Equal("2000", result.TotalCpuMicroseconds);
        Assert.Equal("3000", result.LogicalReads8KiBPages);
        Assert.Equal("9000", result.AbortedExecutionCount);
        Assert.Equal("7", result.ExceptionExecutionCount);
    }

    [Fact]
    public void RejectsAQueryStoreCadenceFasterThanTheCycleThatSchedulesItOrLongerThanADay()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new AtlasCollectionOptions
        {
            RefreshInterval = TimeSpan.FromMinutes(5),
            QueryStoreRefreshInterval = TimeSpan.FromMinutes(1),
            StaleAfter = TimeSpan.FromMinutes(5),
        }.Validate());
        Assert.Throws<ArgumentOutOfRangeException>(() => new AtlasCollectionOptions
        {
            QueryStoreRefreshInterval = TimeSpan.FromDays(1) + TimeSpan.FromSeconds(1),
        }.Validate());
        new AtlasCollectionOptions { QueryStoreRefreshInterval = TimeSpan.FromMinutes(15) }.Validate();
    }

    [Theory]
    [InlineData("ON", false)]
    [InlineData("READ_ONLY", false)]
    [InlineData("OFF", true)]
    public void OnlyAReadableQueryStoreDefersInsteadOfReportingItsOwnCondition(string state, bool describesTheState)
    {
        var options = AtlasComponentOutcome.Success(new AtlasQueryStoreOptionsResult(state, 0), 1, "Options available.");

        var deferred = SqlClientAtlasProbeExecutor.WorkloadOutcomeWithoutProbe(null, options);
        var probed = SqlClientAtlasProbeExecutor.WorkloadOutcomeWithoutProbe(
            "querystore.database_workload_summary_2022", options);

        Assert.NotNull(deferred);
        Assert.Equal(!describesTheState, deferred.IsDeferred);
        // A probe id only ever reaches a round trip through this null, so the gate is the whole story.
        Assert.Equal(describesTheState, probed is not null);
    }

    [Fact]
    public void DeniedQueryStoreOptionsOutrankTheCadenceSoNoRetainedValueCanBeSubstituted()
    {
        var denied = AtlasComponentOutcome.Failure<AtlasQueryStoreOptionsResult>(
            DataStatus.PermissionDenied, "Query Store options permission denied.");

        var outcome = SqlClientAtlasProbeExecutor.WorkloadOutcomeWithoutProbe(null, denied);

        Assert.NotNull(outcome);
        Assert.False(outcome.IsDeferred);
        Assert.Equal(DataStatus.PermissionDenied, outcome.Status);
    }

    [Fact]
    public async Task QueryStoreIsNotProbedAgainUntilItsOwnIntervalElapsesAndItsEarlierValuesStand()
    {
        var clock = new ManualTimeProvider(ParseDate("2026-08-17T13:00:00Z"));
        var executions = "10";
        var windowEnd = ParseDate("2026-08-17T13:00:00Z");
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
            Result = name => DatabaseResult(name) with
            {
                QueryStoreWorkload = AtlasComponentOutcome.Success(
                    new AtlasQueryStoreWorkloadResult(
                        executions, "2000", "1000", "40", windowEnd - TimeSpan.FromHours(24), windowEnd),
                    7,
                    "Workload available."),
            },
        };
        var collector = Collector(executor, CadenceOptions(), clock);

        var first = await collector.CollectAsync(1, CancellationToken.None);
        executions = "999";
        windowEnd = ParseDate("2026-08-17T13:14:00Z");
        clock.Advance(TimeSpan.FromMinutes(14));
        var second = await collector.CollectAsync(2, CancellationToken.None);
        clock.Advance(TimeSpan.FromMinutes(1));
        var third = await collector.CollectAsync(3, CancellationToken.None);

        Assert.Equal("querystore.database_workload_summary_2022", executor.Selections[0].Selection.QueryStoreWorkloadProbeId);
        Assert.Null(executor.Selections[1].Selection.QueryStoreWorkloadProbeId);
        Assert.Equal("querystore.database_workload_summary_2022", executor.Selections[2].Selection.QueryStoreWorkloadProbeId);
        Assert.Equal("10", first.Snapshot.Databases[0].QueryStore.ExecutionCount);
        Assert.Equal("10", second.Snapshot.Databases[0].QueryStore.ExecutionCount);
        Assert.Equal("999", third.Snapshot.Databases[0].QueryStore.ExecutionCount);
        // The retained cycle read no Query Store rows at all, which is the saving being claimed.
        Assert.Equal(first.Status.RowCount - 7, second.Status.RowCount);
        Assert.Equal(first.Status.RowCount, third.Status.RowCount);
        Assert.Equal(0, second.Status.FailureCount);
        Assert.Equal(0, second.Status.SkipCount);
        Assert.Equal(AtlasCollectorState.Ready, second.Status.State);
    }

    [Fact]
    public async Task RetainedQueryStoreEvidenceKeepsItsOriginalObservationAndWindowInsteadOfBeingRestamped()
    {
        var clock = new ManualTimeProvider(ParseDate("2026-08-17T13:00:00Z"));
        var probedAt = ParseDate("2026-08-17T13:00:00Z");
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
            Result = name => DatabaseResult(name) with
            {
                QueryStoreWorkload = AtlasComponentOutcome.Success(
                    new AtlasQueryStoreWorkloadResult(
                        "10", "2000", "1000", "40", probedAt - TimeSpan.FromHours(24), probedAt),
                    7,
                    "Workload available."),
                SourceTimestamp = probedAt,
            },
        };
        var collector = Collector(executor, CadenceOptions(), clock);

        var first = await collector.CollectAsync(1, CancellationToken.None);
        probedAt = ParseDate("2026-08-17T13:14:00Z");
        clock.Advance(TimeSpan.FromMinutes(14));
        var second = await collector.CollectAsync(2, CancellationToken.None);

        var original = first.Snapshot.Databases[0].QueryStore;
        var retained = second.Snapshot.Databases[0].QueryStore;
        Assert.Equal(ParseDate("2026-08-17T13:00:00Z"), original.Evidence.ObservedAt);
        Assert.Equal(original.Evidence.ObservedAt, retained.Evidence.ObservedAt);
        Assert.Equal(original.WindowStart, retained.WindowStart);
        Assert.Equal(original.WindowEnd, retained.WindowEnd);
        // Neither this cycle's collection time nor its source timestamp may become the observation.
        Assert.NotEqual(second.Snapshot.GeneratedAt, retained.Evidence.ObservedAt);
        Assert.NotEqual(ParseDate("2026-08-17T13:14:00Z"), retained.Evidence.ObservedAt);
        Assert.Equal(original.Evidence.FreshUntil, retained.Evidence.FreshUntil);
        Assert.Equal(ParseDate("2026-08-17T13:03:00Z"), retained.Evidence.FreshUntil);
        Assert.Contains("unchanged from an earlier Query Store collection", retained.Reason, StringComparison.Ordinal);
        Assert.DoesNotContain("unchanged from an earlier", original.Reason, StringComparison.Ordinal);
        // The live sample beside it is still this cycle's, so only the deferred component ages.
        Assert.Equal(second.Snapshot.GeneratedAt, ParseDate("2026-08-17T13:14:00Z"));
    }

    [Fact]
    public async Task AQueryStoreThatBecomesUnreadableIsReportedAsItselfRatherThanAsTheRetainedSuccess()
    {
        var clock = new ManualTimeProvider(ParseDate("2026-08-17T13:00:00Z"));
        var denied = false;
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
            Result = name => denied
                ? DatabaseResult(name) with
                {
                    QueryStoreOptions = AtlasComponentOutcome.Failure<AtlasQueryStoreOptionsResult>(
                        DataStatus.PermissionDenied, "Query Store options permission denied."),
                    QueryStoreWorkload = AtlasComponentOutcome.Skipped<AtlasQueryStoreWorkloadResult>(
                        DataStatus.PermissionDenied, "Workload depends on options."),
                }
                : DatabaseResult(name),
        };
        var collector = Collector(executor, CadenceOptions(), clock);

        await collector.CollectAsync(1, CancellationToken.None);
        denied = true;
        clock.Advance(TimeSpan.FromMinutes(1));
        var second = await collector.CollectAsync(2, CancellationToken.None);
        denied = false;
        clock.Advance(TimeSpan.FromMinutes(1));
        var third = await collector.CollectAsync(3, CancellationToken.None);

        var deniedQueryStore = second.Snapshot.Databases[0].QueryStore;
        Assert.Equal(QueryStoreCapability.PermissionDenied, deniedQueryStore.Capability);
        Assert.Null(deniedQueryStore.ExecutionCount);
        Assert.Null(deniedQueryStore.WindowEnd);
        // The denial discarded the retained value, so the next cycle probes rather than reusing it.
        Assert.Equal("querystore.database_workload_summary_2022", executor.Selections[2].Selection.QueryStoreWorkloadProbeId);
        Assert.Equal("9007199254740993", third.Snapshot.Databases[0].QueryStore.ExecutionCount);
    }

    [Fact]
    public async Task ADatabaseThatDisappearsAndReturnsIsProbedAgainInsteadOfResurrectingItsRetainedValue()
    {
        var clock = new ManualTimeProvider(ParseDate("2026-08-17T13:00:00Z"));
        var both = new[]
        {
            new AtlasDatabaseIdentity("db-a", "ONLINE", 160, true),
            new AtlasDatabaseIdentity("db-b", "ONLINE", 160, true),
        };
        var executor = new FakeExecutor { Databases = both };
        var collector = Collector(executor, CadenceOptions(), clock);

        await collector.CollectAsync(1, CancellationToken.None);
        executor.Databases = [both[0]];
        clock.Advance(TimeSpan.FromMinutes(1));
        await collector.CollectAsync(2, CancellationToken.None);
        executor.Databases = both;
        clock.Advance(TimeSpan.FromMinutes(1));
        await collector.CollectAsync(3, CancellationToken.None);

        var third = executor.Selections.Skip(3).ToArray();
        Assert.Null(third.Single(request => request.Database == "db-a").Selection.QueryStoreWorkloadProbeId);
        Assert.Equal(
            "querystore.database_workload_summary_2022",
            third.Single(request => request.Database == "db-b").Selection.QueryStoreWorkloadProbeId);
    }

    private static AtlasCollectionOptions CadenceOptions() => new()
    {
        RefreshInterval = TimeSpan.FromMinutes(1),
        QueryStoreRefreshInterval = TimeSpan.FromMinutes(15),
        StaleAfter = TimeSpan.FromMinutes(3),
    };

    private static AtlasCollector Collector(
        FakeExecutor executor,
        AtlasCollectionOptions? options = null,
        TimeProvider? timeProvider = null) =>
        new(executor, new NotProbedLiveAtlasActivitySource(), options ?? new AtlasCollectionOptions(), timeProvider);

    private static AtlasTargetIdentity Target(EnginePlatform platform = EnginePlatform.SqlServerOnPremises) =>
        new(platform, "16.0.1000.1", "Developer", "sqlserver-local:2026-08-17T12:00:00",
            ParseDate("2026-08-17T13:00:00Z"));

    private static AtlasDatabaseProbeResult DatabaseResult(string name) => new(
        new AtlasDatabaseIdentity(name, "ONLINE", 160, true),
        AtlasComponentOutcome.Success(
            new AtlasSpaceResult("9007199254740993", "4503599627370496", "1048576", "524288"),
            3,
            "Space available."),
        AtlasComponentOutcome.Success(
            new AtlasQueryStoreOptionsResult("ON", 0),
            1,
            "Options available."),
        AtlasComponentOutcome.Success(
            new AtlasQueryStoreWorkloadResult(
            "9007199254740993", "27021597764222979", "18014398509481986",
            "72057594037927944", ParseDate("2026-08-16T13:00:00Z"),
            ParseDate("2026-08-17T13:00:00Z")),
            1,
            "Workload available."),
        AtlasComponentOutcome.Success<IReadOnlyList<AtlasFileIoCounter>>(
            [new AtlasFileIoCounter(1, "100", "200", 1000)],
            1,
            "I/O available."),
        ParseDate("2026-08-17T13:00:00Z"),
        1);

    private static DateTimeOffset ParseDate(string value) =>
        DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);

    private sealed class FixedJitter : IReconnectJitter
    {
        public double NextUnit() => 0.5;
    }

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;
        private long _timestamp;
        public override DateTimeOffset GetUtcNow() => _now;
        public override long GetTimestamp() => _timestamp;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public void Advance(TimeSpan value)
        {
            _now += value;
            _timestamp += value.Ticks;
        }
    }

    private sealed class FakeExecutor : IAtlasProbeExecutor
    {
        private int _active;
        public AtlasTargetIdentity Target { get; set; } = AtlasCollectorTests.Target();
        public IReadOnlyList<AtlasDatabaseIdentity> Databases { get; set; } = [];
        public Func<string, AtlasDatabaseProbeResult> Result { get; set; } = DatabaseResult;
        public TimeSpan Delay { get; set; }
        public ProbeExecutionException? IdentityFailure { get; set; }
        public Task? Block { get; set; }
        public TaskCompletionSource? Entered { get; set; }
        public int DiscoveryCalls { get; private set; }
        public int MaximumActive { get; private set; }
        public List<ProbeRequest> Selections { get; } = [];

        public Task<AtlasTargetIdentity> GetTargetIdentityAsync(CancellationToken cancellationToken) =>
            IdentityFailure is null
                ? Task.FromResult(Target)
                : Task.FromException<AtlasTargetIdentity>(IdentityFailure);

        public Task<IReadOnlyList<AtlasDatabaseIdentity>> DiscoverDatabasesAsync(CancellationToken cancellationToken)
        {
            DiscoveryCalls++;
            return Task.FromResult(Databases);
        }

        public async Task<AtlasDatabaseProbeResult> CollectDatabaseAsync(
            string databaseName,
            AtlasProbeSelection selection,
            DateTimeOffset queryStoreWindowStart,
            DateTimeOffset queryStoreWindowEnd,
            CancellationToken cancellationToken)
        {
            lock (Selections) Selections.Add(new ProbeRequest(databaseName, selection));
            var active = Interlocked.Increment(ref _active);
            MaximumActive = Math.Max(MaximumActive, active);
            try
            {
                Entered?.TrySetResult();
                if (Block is not null) await Block.WaitAsync(cancellationToken);
                if (Delay > TimeSpan.Zero) await Task.Delay(Delay, cancellationToken);
                var result = Result(databaseName);

                // The real executor decides what an ungated workload probe returns, so the fake
                // defers to it rather than inventing a second answer that could drift from it.
                return selection.QueryStoreWorkloadProbeId is null &&
                       SqlClientAtlasProbeExecutor.WorkloadOutcomeWithoutProbe(null, result.QueryStoreOptions) is { } unprobed
                    ? result with { QueryStoreWorkload = unprobed }
                    : result;
            }
            finally
            {
                Interlocked.Decrement(ref _active);
            }
        }
    }

    private sealed record ProbeRequest(string Database, AtlasProbeSelection Selection);
}
