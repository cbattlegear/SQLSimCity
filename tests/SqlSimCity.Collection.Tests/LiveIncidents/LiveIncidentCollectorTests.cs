using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.LiveIncidents;

/// <summary>
/// Exercises <see cref="LiveIncidentCollector"/> against <see cref="FakeLiveIncidentProbeExecutor"/>:
/// disappearing requests across cycles, per-subsystem degradation on permission/timeout errors,
/// Azure-scope file-I/O/scheduler variant selection, and the memory-grant waiting state
/// (requirements 2, 5, 6).
/// </summary>
public class LiveIncidentCollectorTests
{
    private static readonly DateTimeOffset EngineStart = new(2024, 1, 1, 0, 0, 0, TimeSpan.Zero);

    // The trailing 0/1/null arguments are the probe's cap-disclosure columns (visible_session_count,
    // selection_rank, and the two untruncated text lengths). These tests do not exercise a cap; the
    // collector floors the visible count at the number of rows it actually received.
    private static ActiveRequestRow Request(int sessionId, int requestId = 1) => new(
        sessionId, "app_user", "app-host", "MyApp", "running",
        null, null, requestId, "running", "SELECT", null, null, null, null,
        DateTimeOffset.UnixEpoch, 10, 5, 100, 50, 200, 0, 5, "AppDb", "SELECT 1", "SELECT 1",
        0, 1, "SELECT 1".Length, "SELECT 1".Length);

    [Fact]
    public async Task RequestPresentInPreviousCycleButMissingNowIsReportedAsDisappearedNotDropped()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        probes.ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([Request(51)]);
        var first = await collector.CollectAsync(1, CancellationToken.None);
        Assert.Single(first.Requests, r => r.RequestId == "req:51:1" && r.Availability == SampleAvailability.Available);

        probes.ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([]);
        var second = await collector.CollectAsync(2, CancellationToken.None);

        var disappeared = Assert.Single(second.Requests);
        Assert.Equal("req:51:1", disappeared.RequestId);
        Assert.Equal(SampleAvailability.Disappeared, disappeared.Availability);
        Assert.NotNull(disappeared.AvailabilityReason);
    }

    [Fact]
    public async Task PermissionDeniedOnOneSubsystemDegradesOnlyThatSubsystem()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([Request(10)]),
            MemoryGrants = _ => throw new ProbePermissionDeniedException(
                "The login lacks VIEW SERVER STATE permission required for memory grant visibility.", 300, 14),
            LogSpaceUsage = _ => Task.FromResult<LogSpaceRow?>(new LogSpaceRow(100m, 10m, 10m)),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.Available, snapshot.Status); // requests still succeeded overall
        Assert.Single(snapshot.Requests);
        var unavailable = Assert.Single(snapshot.Diagnostics.UnavailableFields);
        Assert.Equal("memoryGrants", unavailable.Field);
        Assert.Equal(DataStatus.PermissionDenied, unavailable.Status);
        Assert.Empty(snapshot.MemoryGrants);
    }

    [Fact]
    public async Task TimeoutOnEverySubsystemYieldsDisconnectedOverallStatusNotAnEmptySilentSnapshot()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => throw new ProbeTimeoutException("The server identity probe timed out.", null, null),
            ActiveRequests = _ => throw new ProbeTimeoutException("The active-requests probe timed out.", null, null),
            WaitingTasks = _ => throw new ProbeTimeoutException("The waiting-tasks probe timed out.", null, null),
            BlockingInputs = _ => throw new ProbeTimeoutException("The blocking-inputs probe timed out.", null, null),
            MemoryGrants = _ => throw new ProbeTimeoutException("The memory-grants probe timed out.", null, null),
            TempdbUsage = (_, _) => throw new ProbeTimeoutException("The tempdb probe timed out.", null, null),
            FileIoStats = (_, _) => throw new ProbeTimeoutException("The file I/O probe timed out.", null, null),
            SchedulerPressure = (_, _) => throw new ProbeTimeoutException("The scheduler probe timed out.", null, null),
            LogSpaceUsage = _ => throw new ProbeTimeoutException("The log space probe timed out.", null, null),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.Disconnected, snapshot.Status);
        Assert.NotEmpty(snapshot.Diagnostics.UnavailableFields);

        // Every subsystem that actually attempted its SQL probe and timed out reports Disconnected.
        // tempdb is the one exception: with the server-identity probe also failing, the platform is
        // Unknown this cycle, so tempdb is never attempted at all (requirement 4) and reports
        // Unknown rather than a misleading Disconnected for a probe call that never happened.
        var tempdbField = Assert.Single(snapshot.Diagnostics.UnavailableFields, f => f.Field == "tempdb");
        Assert.Equal(DataStatus.Unknown, tempdbField.Status);
        Assert.All(
            snapshot.Diagnostics.UnavailableFields.Where(f => f.Field != "tempdb"),
            f => Assert.Equal(DataStatus.Disconnected, f.Status));
    }

    [Theory]
    [InlineData(5, true)]  // Azure SQL Database: always request the DB-scoped, Azure-safe variant
    [InlineData(2, false)] // on-prem SQL Server 2016 (major version parsed from ProductVersion below)
    public async Task FileIoProbeReceivesAzureScopedFlagMatchingNegotiatedPlatform(int engineEdition, bool expectedAzureScoped)
    {
        bool? observedAzureScoped = null;
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart, engineEdition)),
            FileIoStats = (azureScoped, _) =>
            {
                observedAzureScoped = azureScoped;
                return Task.FromResult<IReadOnlyList<FileIoRow>>([]);
            },
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(expectedAzureScoped, observedAzureScoped);
    }

    [Fact]
    public async Task SchedulerProbeRequestsIdealWorkersLimitOnSqlServer2019OrNewerNotOnOlderVersions()
    {
        bool? observedFlag = null;
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(new ServerIdentityResult(
                "srv", "15.0.2000.5", "RTM", "Enterprise Edition", 3, false, 8, 8, 32_768, EngineStart)),
            SchedulerPressure = (includeIdeal, _) =>
            {
                observedFlag = includeIdeal;
                return Task.FromResult<IReadOnlyList<SchedulerRow>>([]);
            },
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        await collector.CollectAsync(1, CancellationToken.None);

        Assert.True(observedFlag); // SQL Server 2019 is major version 15
    }

    [Fact]
    public async Task MemoryGrantWithNullGrantTimeIsReportedAsWaitingForGrant()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            MemoryGrants = _ => Task.FromResult<IReadOnlyList<MemoryGrantRow>>([
                new MemoryGrantRow(77, 1, 0, 1, DateTimeOffset.UnixEpoch, null, 51200, null, 40000, null, null, null, 12.5m, 30, 1500, null, null, "SELECT big_table"),
                new MemoryGrantRow(78, 1, 0, 1, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, 51200, 51200, 40000, 10000, 12000, 45000, 8.0m, 30, null, null, null, "SELECT other_table"),
            ]),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var waiting = Assert.Single(snapshot.MemoryGrants, g => g.SessionId == 77);
        Assert.True(waiting.IsWaitingForGrant);
        Assert.Null(waiting.GrantTime);

        var granted = Assert.Single(snapshot.MemoryGrants, g => g.SessionId == 78);
        Assert.False(granted.IsWaitingForGrant);
    }

    [Fact]
    public async Task AzureSqlDatabaseIsAlwaysDatabaseScopedWithUnavailableServerWideReasonNotZero()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart, engineEdition: 5)),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Azure SQL DB Test", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal("DatabaseScoped", snapshot.Target.VisibilityScope);
        Assert.NotNull(snapshot.Target.UnavailableServerWideEvidenceReason);
    }

    // --- Requirement 3: platform must never come solely from a probe that can fail on Azure. ---

    [Fact]
    public async Task IdentityProbeFailureWithNoConfiguredPlatformYieldsUnknownNeverUnsupported()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => throw new ProbePermissionDeniedException(
                "The login lacks VIEW SERVER STATE permission required for server identity.", 300, 14),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(nameof(EnginePlatform.Unknown), snapshot.Target.Platform);
        Assert.Equal("Unknown", snapshot.Target.VisibilityScope);
        Assert.NotNull(snapshot.Target.UnavailableServerWideEvidenceReason);
    }

    [Fact]
    public async Task ConfiguredPlatformIsUsedIndependentlyOfTheIdentityProbe()
    {
        // The identity probe fails outright (as it legitimately can for a contained Azure SQL
        // Database user), but Connected-mode DI wiring supplied the platform from its own
        // connection profile configuration -- the collector must trust that, not fall back to
        // Unknown, and must select the Azure-safe file-I/O probe. Azure SQL Database does not
        // expose a supported connection context for the tempdb-only allocation DMVs.
        var tempdbProbeWasCalled = false;
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => throw new ProbePermissionDeniedException("no VIEW SERVER STATE", 300, 14),
            TempdbUsage = (_, _) =>
            {
                tempdbProbeWasCalled = true;
                return Task.FromResult(new TempdbUsageRaw([], [], []));
            },
        };
        var collector = new LiveIncidentCollector(
            probes, "target-1", "Test Server", TimeProvider.System, configuredPlatform: EnginePlatform.AzureSqlDatabase);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(nameof(EnginePlatform.AzureSqlDatabase), snapshot.Target.Platform);
        Assert.Equal("DatabaseScoped", snapshot.Target.VisibilityScope);
        Assert.False(tempdbProbeWasCalled);
        Assert.Equal(DataStatus.Unsupported, snapshot.Tempdb.Status);
    }

    // --- Requirement 4: tempdb-only DMVs are unavailable from Azure SQL Database user connections. ---

    [Fact]
    public async Task AzureSqlDatabaseDoesNotClaimTempdbSessionOrTaskUsage()
    {
        var tempdbProbeWasCalled = false;
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart, engineEdition: 5)),
            TempdbUsage = (_, _) =>
            {
                tempdbProbeWasCalled = true;
                return Task.FromResult(new TempdbUsageRaw(
                    [], [new TempdbSessionRow(51, 10, 2, 0, 0, VisibleSessionCount: 1)], []));
            },
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.False(tempdbProbeWasCalled);
        Assert.Equal(DataStatus.Unsupported, snapshot.Tempdb.Status);
        Assert.Empty(snapshot.Tempdb.Files);
        Assert.Empty(snapshot.Tempdb.Sessions);
        var unavailable = Assert.Single(snapshot.Diagnostics.UnavailableFields, f => f.Field == "tempdb");
        Assert.Equal(DataStatus.Unsupported, unavailable.Status);
        Assert.Contains("tempdb", unavailable.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task UnknownPlatformNeverAttemptsTheTempdbProbeAtAll()
    {
        var tempdbProbeWasCalled = false;
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => throw new ProbeTimeoutException("The server identity probe timed out.", null, null),
            TempdbUsage = (_, _) =>
            {
                tempdbProbeWasCalled = true;
                return Task.FromResult(new TempdbUsageRaw([], [], []));
            },
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.False(tempdbProbeWasCalled);
        Assert.Equal(DataStatus.Unknown, snapshot.Tempdb.Status);
        Assert.Contains("platform could not be determined", snapshot.FileIo.Reason, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Azure SQL Database", snapshot.FileIo.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task SqlServerOnPremisesUsesTheFullTempdbProbeNotTheAzureScopedVariant()
    {
        bool? observedAzureScoped = null;
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart, engineEdition: 3)),
            TempdbUsage = (azureScoped, _) =>
            {
                observedAzureScoped = azureScoped;
                return Task.FromResult(new TempdbUsageRaw([], [], []));
            },
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        await collector.CollectAsync(1, CancellationToken.None);

        Assert.False(observedAzureScoped);
    }

    // --- Requirement 5: an idle session (no request row) must never collide with request_id 0. ---

    [Fact]
    public async Task IdleSessionAndRealRequestIdZeroProduceDistinctRequestIdsAndRecordShapes()
    {
        var idleRow = new ActiveRequestRow(
            60, "app_user", "app-host", "MyApp", "sleeping",
            DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, null, null, null, null, null, null, null,
            null, null, null, null, null, null, null, null, null, null, null, 0, 1, null, null);
        var realRequestZeroRow = new ActiveRequestRow(
            61, "app_user", "app-host", "MyApp", "running",
            null, null, 0, "running", "SELECT", null, null, null, null,
            DateTimeOffset.UnixEpoch, 5, 5, 1, 1, 1, 0, 5, "AppDb", "SELECT 1", "SELECT 1",
            0, 2, "SELECT 1".Length, "SELECT 1".Length);

        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([idleRow, realRequestZeroRow]),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var idle = Assert.Single(snapshot.Requests, r => r.SessionId == 60);
        var realZero = Assert.Single(snapshot.Requests, r => r.SessionId == 61);

        Assert.Equal("req:60:idle", idle.RequestId);
        // An idle session holds no request, so it reports no request status. The row stays
        // identifiable as idle through RequestId and SessionStatus without inventing a state the
        // DMV never reported (issue #79).
        Assert.Null(idle.RequestStatus);
        Assert.Equal("sleeping", idle.SessionStatus);
        Assert.Equal("req:61:0", realZero.RequestId);
        Assert.Equal("running", realZero.RequestStatus);
        Assert.NotEqual(idle.RequestId, realZero.RequestId);
    }

    // --- Requirement 6: a failed request probe must mark carried rows Stale, never silently Available. ---

    [Fact]
    public async Task RequestProbeFailureMarksCarriedRowsStaleNotAvailableAndPreservesDisappearanceDetection()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        probes.ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([Request(51)]);
        var first = await collector.CollectAsync(1, CancellationToken.None);
        Assert.Single(first.Requests, r => r.RequestId == "req:51:1" && r.Availability == SampleAvailability.Available);

        probes.ActiveRequests = _ => throw new ProbeTimeoutException("The active-requests probe timed out.", null, null);
        var second = await collector.CollectAsync(2, CancellationToken.None);

        var stale = Assert.Single(second.Requests);
        Assert.Equal("req:51:1", stale.RequestId);
        Assert.Equal(SampleAvailability.Stale, stale.Availability);
        Assert.NotNull(stale.AvailabilityReason);
        Assert.Contains("requests", second.Diagnostics.UnavailableFields.Select(f => f.Field));

        // The probe recovers and the request is genuinely gone: disappearance detection must still
        // work correctly against the real last-known-good data, not the synthetic Stale copy.
        probes.ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([]);
        var third = await collector.CollectAsync(3, CancellationToken.None);

        var disappeared = Assert.Single(third.Requests);
        Assert.Equal("req:51:1", disappeared.RequestId);
        Assert.Equal(SampleAvailability.Disappeared, disappeared.Availability);
    }

    // --- Requirement 7: overall status/sourceTimestamp must reflect real operational evidence. ---

    [Fact]
    public async Task IdentitySuccessAloneWithEveryOperationalProbeFailingYieldsDisconnectedNotAvailable()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => throw new ProbeTimeoutException("timed out", null, null),
            WaitingTasks = _ => throw new ProbeTimeoutException("timed out", null, null),
            BlockingInputs = _ => throw new ProbeTimeoutException("timed out", null, null),
            MemoryGrants = _ => throw new ProbeTimeoutException("timed out", null, null),
            TempdbUsage = (_, _) => throw new ProbeTimeoutException("timed out", null, null),
            FileIoStats = (_, _) => throw new ProbeTimeoutException("timed out", null, null),
            SchedulerPressure = (_, _) => throw new ProbeTimeoutException("timed out", null, null),
            LogSpaceUsage = _ => throw new ProbeTimeoutException("timed out", null, null),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.Disconnected, snapshot.Status);
        Assert.Null(snapshot.SourceTimestamp);
        Assert.Null(snapshot.Diagnostics.SourceTimestamp);
    }

    [Fact]
    public async Task SuccessfulOperationalEvidenceYieldsARealNonNullSourceTimestamp()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([Request(51)]),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.Available, snapshot.Status);
        Assert.NotNull(snapshot.SourceTimestamp);
        Assert.NotNull(snapshot.Diagnostics.SourceTimestamp);
    }

    // --- Requirement 7 (cont'd): every operational subsystem's failure must be surfaced. ---

    [Fact]
    public async Task TempdbFileIoSchedulerAndLogSpaceFailuresAreAllSurfacedInUnavailableFields()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([Request(51)]),
            TempdbUsage = (_, _) => throw new ProbePermissionDeniedException("no tempdb access", 300, 14),
            FileIoStats = (_, _) => throw new ProbePermissionDeniedException("no file io access", 300, 14),
            SchedulerPressure = (_, _) => throw new ProbePermissionDeniedException("no scheduler access", 300, 14),
            LogSpaceUsage = _ => throw new ProbePermissionDeniedException("no log space access", 300, 14),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var fields = snapshot.Diagnostics.UnavailableFields.Select(f => f.Field).ToList();
        Assert.Contains("tempdb", fields);
        Assert.Contains("fileIo", fields);
        Assert.Contains("scheduler", fields);
        Assert.Contains("logSpace", fields);
        Assert.All(snapshot.Diagnostics.UnavailableFields, f => Assert.Equal(DataStatus.PermissionDenied, f.Status));
    }

    // --- Requirement 8: a reset for one file/scheduler counter must reset every sibling counter for that same entity atomically. ---

    private static FileIoRow FileIo(long reads, long bytesRead, long stallRead, long writes, long bytesWritten, long stallWrite, long sampleMs = 1000) =>
        new(DatabaseId: 1, DatabaseName: "AppDb", FileId: 1, TypeDesc: "ROWS", SampleMs: sampleMs,
            NumOfReads: reads, NumOfBytesRead: bytesRead, IoStallReadMs: stallRead,
            NumOfWrites: writes, NumOfBytesWritten: bytesWritten, IoStallWriteMs: stallWrite, IoStall: stallRead + stallWrite);

    [Fact]
    public async Task FileIoResetOnOneCounterForcesEveryOtherCounterOfTheSameFileToResetTooNotAFabricatedDelta()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        probes.FileIoStats = (_, _) => Task.FromResult<IReadOnlyList<FileIoRow>>(
            [FileIo(reads: 1000, bytesRead: 5000, stallRead: 200, writes: 300, bytesWritten: 4000, stallWrite: 50)]);
        await collector.CollectAsync(1, CancellationToken.None);

        // Simulate an engine restart (same identity probe result, so no epoch-marker signal) where
        // only the "reads" counter happens to read lower than before; "bytesRead" coincidentally
        // reads back the exact same value it had last cycle, which -- looked at in isolation --
        // would look like a valid zero-rate delta rather than a reset.
        probes.FileIoStats = (_, _) => Task.FromResult<IReadOnlyList<FileIoRow>>(
            [FileIo(reads: 10, bytesRead: 5000, stallRead: 5, writes: 3, bytesWritten: 10, stallWrite: 1)]);
        var second = await collector.CollectAsync(2, CancellationToken.None);

        var file = Assert.Single(second.FileIo.Files);
        Assert.Equal(CounterEpochState.EpochReset, file.ReadsDelta.State);
        Assert.Equal(CounterEpochState.EpochReset, file.BytesReadDelta.State); // must NOT be Delta/0
        Assert.Equal(CounterEpochState.EpochReset, file.IoStallReadMsDelta.State);
        Assert.Equal(CounterEpochState.EpochReset, file.WritesDelta.State);
        Assert.Equal(CounterEpochState.EpochReset, file.BytesWrittenDelta.State);
        Assert.Equal(CounterEpochState.EpochReset, file.IoStallWriteMsDelta.State);
    }

    [Fact]
    public async Task SchedulerResetOnCpuCounterForcesTheDelayCounterToResetTooNotAFabricatedDelta()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        SchedulerRow Scheduler(long cpuMs, long delayMs) => new(
            SchedulerId: 1, CpuId: 0, Status: "VISIBLE ONLINE", IsOnline: true, IsIdle: false,
            CurrentTasksCount: 1, RunnableTasksCount: 0, CurrentWorkersCount: 4, ActiveWorkersCount: 1,
            WorkQueueCount: 0, PendingDiskIoCount: 0, LoadFactor: 0,
            TotalCpuUsageMs: cpuMs, TotalSchedulerDelayMs: delayMs, IdealWorkersLimit: null);

        probes.SchedulerPressure = (_, _) => Task.FromResult<IReadOnlyList<SchedulerRow>>([Scheduler(10_000, 500)]);
        await collector.CollectAsync(1, CancellationToken.None);

        // CPU usage regresses (a real restart signal); the delay counter coincidentally reads the
        // exact same value as before and would look like a valid zero-rate delta in isolation.
        probes.SchedulerPressure = (_, _) => Task.FromResult<IReadOnlyList<SchedulerRow>>([Scheduler(50, 500)]);
        var second = await collector.CollectAsync(2, CancellationToken.None);

        var scheduler = Assert.Single(second.Scheduler.Schedulers);
        Assert.Equal(CounterEpochState.EpochReset, scheduler.CpuUsageMsDelta.State);
        Assert.Equal(CounterEpochState.EpochReset, scheduler.SchedulerDelayMsDelta.State); // must NOT be Delta/0
    }

    // --- Issue #81 part 3: a bounded live sample has to disclose what it left out. ---
    //
    // Live collection had no row cap and no text cap, so snapshot size was bounded by the watched
    // workload rather than by anything SqlSimCity controlled. Measured against SQL Server 2022,
    // 5,009 idle sessions carrying no batch text produced a 5.88 MiB snapshot, and 50 sessions each
    // executing a 1 MiB batch produced a 100.2 MiB snapshot that took 4.35 s to collect -- longer
    // than the sampler's own cadence. Both caps now exist, and the point of these tests is that
    // neither is allowed to shrink the evidence quietly.

    private static ActiveRequestRow CappedRow(int sessionId, int visibleSessionCount, int selectionRank) => new(
        sessionId, "app_user", "app-host", "MyApp", "running",
        null, null, 1, "running", "SELECT", null, null, null, null,
        DateTimeOffset.UnixEpoch, 10, 5, 100, 50, 200, 0, 5, "AppDb", "SELECT 1", "SELECT 1",
        visibleSessionCount, selectionRank, "SELECT 1".Length, "SELECT 1".Length);

    [Fact]
    public async Task RowCapReportsHowManySessionsWereVisibleSoACappedSampleIsNotASmallerServer()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>(
                [CappedRow(51, visibleSessionCount: 5009, selectionRank: 1),
                 CappedRow(52, visibleSessionCount: 5009, selectionRank: 2)]),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var truncation = Assert.Single(snapshot.Diagnostics.Truncations);
        Assert.Equal("requests", truncation.Field);
        Assert.Equal(2, truncation.ReturnedRows);
        Assert.Equal(5009, truncation.TotalRows);
        Assert.Contains("5009", truncation.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnUncappedSampleReportsNoTruncationSoDisclosureNeverImpliesLossThatDidNotHappen()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>(
                [CappedRow(51, visibleSessionCount: 2, selectionRank: 1),
                 CappedRow(52, visibleSessionCount: 2, selectionRank: 2)]),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Empty(snapshot.Diagnostics.Truncations);
        Assert.All(snapshot.Requests, r => Assert.Null(r.BatchTextTruncation));
        Assert.All(snapshot.Requests, r => Assert.Null(r.CurrentStatementTextTruncation));
    }

    [Fact]
    public async Task TruncatedTextCarriesItsUntruncatedLengthSoItIsNeverMistakenForAShortStatement()
    {
        var row = new ActiveRequestRow(
            51, "app_user", "app-host", "MyApp", "running",
            null, null, 1, "running", "SELECT", null, null, null, null,
            DateTimeOffset.UnixEpoch, 10, 5, 100, 50, 200, 0, 5, "AppDb",
            BatchText: "SELECT 1",
            CurrentStatementText: "SELECT",
            VisibleSessionCount: 1,
            SelectionRank: 1,
            BatchTextLength: 1_048_576,
            CurrentStatementTextLength: 262_144);
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([row]),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var request = Assert.Single(snapshot.Requests);
        var batch = Assert.IsType<LiveTextTruncationV1>(request.BatchTextTruncation);
        Assert.Equal(8, batch.RetainedCharacters);
        Assert.Equal(1_048_576, batch.TotalCharacters);
        Assert.Contains("1048576", batch.Reason, StringComparison.Ordinal);

        // Tracked separately: a short statement inside a very long batch is truncated in the batch
        // and not in the statement, so one disclosure can never stand in for the other.
        var statement = Assert.IsType<LiveTextTruncationV1>(request.CurrentStatementTextTruncation);
        Assert.Equal(6, statement.RetainedCharacters);
        Assert.Equal(262_144, statement.TotalCharacters);
    }

    [Fact]
    public async Task TextReturnedWholeCarriesNoTruncationEvenThoughTheProbeReportedItsLength()
    {
        var row = new ActiveRequestRow(
            51, "app_user", "app-host", "MyApp", "running",
            null, null, 1, "running", "SELECT", null, null, null, null,
            DateTimeOffset.UnixEpoch, 10, 5, 100, 50, 200, 0, 5, "AppDb",
            BatchText: "SELECT 1",
            CurrentStatementText: "SELECT 1",
            VisibleSessionCount: 1,
            SelectionRank: 1,
            BatchTextLength: 8,
            CurrentStatementTextLength: 8);
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([row]),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var request = Assert.Single(snapshot.Requests);
        Assert.Null(request.BatchTextTruncation);
        Assert.Null(request.CurrentStatementTextTruncation);
    }

    // The row cap and requirement 6's disappearance disclosure interact, and the interaction is a
    // trap: "absent from this cycle" only means "no longer running" while the sample is complete.
    // Under a cap a request can be absent purely because it ranked below the cap, so reporting it
    // Disappeared would assert an ending that never happened -- a bandwidth fix turning into a
    // fabricated fact.
    [Fact]
    public async Task ARequestPushedOutByTheRowCapIsNeverReportedAsHavingDisappeared()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>(
                [CappedRow(51, visibleSessionCount: 2, selectionRank: 1),
                 CappedRow(52, visibleSessionCount: 2, selectionRank: 2)]),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);
        await collector.CollectAsync(1, CancellationToken.None);

        // Session 52 is still running; the sample is simply capped at one row now.
        probes.ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>(
            [CappedRow(51, visibleSessionCount: 2, selectionRank: 1)]);
        var second = await collector.CollectAsync(2, CancellationToken.None);

        Assert.DoesNotContain(second.Requests, r => r.Availability == SampleAvailability.Disappeared);
        var truncation = Assert.Single(second.Diagnostics.Truncations);
        Assert.Contains("Disappearance detection is suspended", truncation.Reason, StringComparison.Ordinal);
    }

    // The guard above must not cost the disclosure it protects: when the sample is complete, a
    // request that really did end still has to be reported rather than dropped.
    [Fact]
    public async Task DisappearanceIsStillReportedWhenTheSampleWasNotCapped()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>(
                [CappedRow(51, visibleSessionCount: 2, selectionRank: 1),
                 CappedRow(52, visibleSessionCount: 2, selectionRank: 2)]),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);
        await collector.CollectAsync(1, CancellationToken.None);

        probes.ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>(
            [CappedRow(51, visibleSessionCount: 1, selectionRank: 1)]);
        var second = await collector.CollectAsync(2, CancellationToken.None);

        Assert.Empty(second.Diagnostics.Truncations);
        var disappeared = Assert.Single(second.Requests, r => r.Availability == SampleAvailability.Disappeared);
        Assert.Equal("req:52:1", disappeared.RequestId);
    }
    // tempdb's session and task views carry a row per session and per task whether or not tempdb
    // was ever touched, so they scale with connection count rather than tempdb activity. Once the
    // request sample was capped they became the largest part of the snapshot -- 1.76 MiB of
    // mostly-zero rows at 5,028 sessions -- so they are capped too, and on the same terms.
    [Fact]
    public async Task TempdbRowCapsReportTheirPreCapCountsSeparatelyForSessionsAndTasks()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            TempdbUsage = (_, _) => Task.FromResult(new TempdbUsageRaw(
                [],
                [new TempdbSessionRow(51, 10, 2, 0, 0, VisibleSessionCount: 5028)],
                [new TempdbTaskRow(51, 1, 0, 10, 2, 0, 0, VisibleTaskCount: 4096)])),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var sessions = Assert.Single(snapshot.Diagnostics.Truncations, t => t.Field == "tempdb.sessions");
        Assert.Equal(1, sessions.ReturnedRows);
        Assert.Equal(5028, sessions.TotalRows);

        // Reported separately: the two views are capped independently, so one count can never be
        // read as covering the other.
        var tasks = Assert.Single(snapshot.Diagnostics.Truncations, t => t.Field == "tempdb.tasks");
        Assert.Equal(1, tasks.ReturnedRows);
        Assert.Equal(4096, tasks.TotalRows);
    }

    [Fact]
    public async Task UncappedTempdbUsageReportsNoTruncationAtAll()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            TempdbUsage = (_, _) => Task.FromResult(new TempdbUsageRaw(
                [],
                [new TempdbSessionRow(51, 10, 2, 0, 0, VisibleSessionCount: 1)],
                [new TempdbTaskRow(51, 1, 0, 10, 2, 0, 0, VisibleTaskCount: 1)])),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Empty(snapshot.Diagnostics.Truncations);
    }
}
