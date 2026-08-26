using System.Numerics;
using Microsoft.Extensions.Time.Testing;
using SqlSimCity.Collection.Atlas;
using SqlSimCity.Collection.Blocking;
using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Negotiation;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Edge.Connector;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;
using SqlSimCity.Storage;

namespace SqlSimCity.Edge.Tests;

public sealed class ConnectedObservationProviderTests
{
    [Fact]
    public async Task MissingAuthenticationSecretFailsClosedBeforeProviderStarts()
    {
        var root = Path.Combine(
            AppContext.BaseDirectory, "missing-edge-secret-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var source = Options();
            var profile = new ConnectionProfile(
                source.Profile.Id,
                source.Profile.Server,
                source.Profile.InitialDatabase,
                source.Profile.Timeouts,
                source.Profile.Pool,
                source.Profile.Encryption,
                new SqlLoginAuthenticationStrategy(
                    "collector", new SecretFileReference("missing-password")),
                source.Profile.HostNameInCertificate,
                source.Profile.TrustServerCertificate);
            var options = source with
            {
                Profile = profile,
                SecretFiles = new SecretFileProviderOptions
                {
                    SecretsDirectory = root,
                },
            };

            var exception = await Assert.ThrowsAsync<ConnectorConfigurationException>(
                () => ConnectedObservationProvider.CreateAsync(options));

            Assert.Equal(
                "A configured SQL authentication secret file is missing, invalid, empty, or unreadable.",
                exception.Message);
            Assert.DoesNotContain(root, exception.ToString(), StringComparison.Ordinal);
            Assert.DoesNotContain("missing-password", exception.ToString(), StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task FakeConnectedCycleInvokesProductionCollectorsAndEmitsSanitizedFiveSections()
    {
        var now = new DateTimeOffset(2026, 8, 18, 7, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(now);
        var options = Options();
        var state = new ConnectedObservationState(options);
        var liveProbe = new FakeLiveProbe(now);
        var liveCollector = new LiveIncidentCollector(
            liveProbe, "target-a", "Connected target", time,
            configuredPlatform: EnginePlatform.SqlServerOnPremises);
        var atlasProbe = new FakeAtlasProbe(now);
        var atlasCollector = new AtlasCollector(
            atlasProbe,
            new LiveIncidentAtlasActivitySource(
                state.GetCurrentResponse, "target-a"),
            options.Atlas,
            time);
        var capabilityProbe = new FakeCapabilityProbe(now);
        var capabilityNegotiator = new CapabilityNegotiator(capabilityProbe, time);
        var queryIncremental = new FakeQueryIncremental(now);
        var volatileStore = new VolatileProtectedRecordStore();
        var repository = new ProtectedQueryStoreRepository(volatileStore);
        var queryStatus = new QueryStoreCollectionStatusTracker();
        var querySink = new ProtectedQueryStoreHistorySink(repository, queryStatus);
        var queryCollector = new IncrementalQueryStoreCollector(
            queryIncremental, querySink, options.QueryStore, time);
        var querySource = new ConnectedQueryStoreHistorySource(
            repository,
            queryIncremental,
            new SecureShowplanParser(),
            queryStatus,
            time,
            allowRawPayloadHydration: false);
        var cityProbe = new FakeCityProbe(now);
        var citySource = new ConnectedDatabaseCitySource(state, cityProbe);
        var owned = new TrackingDisposable();
        await using var provider = new ConnectedObservationProvider(
            options,
            state,
            liveCollector,
            atlasCollector,
            capabilityNegotiator,
            queryIncremental,
            queryCollector,
            querySource,
            citySource,
            [queryCollector, volatileStore, owned]);

        var first = await provider.CollectAsync(now, CancellationToken.None);
        time.Advance(TimeSpan.FromSeconds(15));
        var second = await provider.CollectAsync(time.GetUtcNow(), CancellationToken.None);

        Assert.Equal(Enum.GetValues<ObservationSection>(), first.Select(value => value.Section).Order());
        Assert.Equal(2, liveProbe.IdentityCalls);
        Assert.Equal(2, atlasProbe.IdentityCalls);
        Assert.Equal(2, capabilityProbe.IdentityCalls);
        Assert.Equal(2, queryIncremental.StateCalls);
        Assert.Equal(8, cityProbe.Calls);
        Assert.Equal(0, queryIncremental.RawTextCalls);
        Assert.Equal(0, queryIncremental.RawPlanCalls);
        Assert.Equal(
            first.Select(value => value.Section),
            second.Select(value => value.Section));

        var live = Assert.IsType<LiveIncidentResponseV1>(
            first.Single(value => value.Section == ObservationSection.Live).Payload);
        var request = Assert.Single(live.Snapshot!.Requests);
        Assert.Null(request.LoginName);
        Assert.Null(request.HostName);
        Assert.Null(request.ProgramName);
        Assert.Null(request.BatchText);
        Assert.Null(request.CurrentStatementText);
        Assert.Null(Assert.Single(live.Snapshot.MemoryGrants).BatchText);
        var query = Assert.IsType<QueryStoreObservationV1>(
            first.Single(value => value.Section == ObservationSection.QueryStore).Payload);
        Assert.Single(query.Families);
        Assert.Equal(
            QueryTextAvailability.Restricted,
            query.Families[0].Family.Text.Availability);
        Assert.Empty(query.Plans);

        await provider.DisposeAsync();
        Assert.True(owned.Disposed);
        await Assert.ThrowsAsync<ObjectDisposedException>(() =>
            provider.CollectAsync(time.GetUtcNow(), CancellationToken.None));
    }

    private static ConnectedSourceOptions Options()
    {
        var profile = new ConnectionProfile(
            new ConnectionProfileId("edge:test"),
            new ServerAddress("sql.example.internal", null, 1433),
            "appdb",
            new ConnectionTimeouts(15, 30),
            new PoolBounds(0, 10),
            EncryptionPolicy.Mandatory,
            new KerberosAuthenticationStrategy());
        var atlas = new AtlasCollectionOptions
        {
            TargetId = "target-a",
            DisplayName = "Connected target",
            KnownDatabases = ["appdb"],
            RefreshInterval = TimeSpan.FromSeconds(10),
            StaleAfter = TimeSpan.FromMinutes(3),
        };
        return new ConnectedSourceOptions(
            profile,
            EnginePlatform.SqlServerOnPremises,
            "Connected target",
            ["appdb"],
            new SecretFileProviderOptions { SecretsDirectory = "secrets" },
            atlas,
            new QueryStoreCollectionOptions(PageSize: 10, DatabaseConcurrency: 1));
    }

    private sealed class FakeLiveProbe(DateTimeOffset now) : ILiveIncidentProbeExecutor
    {
        public int IdentityCalls { get; private set; }

        public Task<ServerIdentityResult> GetServerIdentityAsync(CancellationToken cancellationToken)
        {
            IdentityCalls++;
            return Task.FromResult(new ServerIdentityResult(
                null, "16.0.1000.1", null, null, 3, false, 4, 4, 4096, now.AddHours(-1)));
        }

        public Task<IReadOnlyList<ActiveRequestRow>> GetActiveRequestsAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<ActiveRequestRow>>(
            [
                new(
                    51, "private-login", "private-host", "private-program", "running",
                    now, now, 1, "running", "SELECT", null, null, null, null, now,
                    10, 2, 1, 0, 1, 0, 5, "appdb", "RAW SQL BATCH", "RAW SQL STATEMENT",
                    1, 1, "RAW SQL BATCH".Length, "RAW SQL STATEMENT".Length),
            ]);

        public Task<IReadOnlyList<WaitingTaskFact>> GetWaitingTasksAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<WaitingTaskFact>>([]);
        public Task<IReadOnlyList<BlockingInputFact>> GetBlockingInputsAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<BlockingInputFact>>([]);
        public Task<IReadOnlyList<MemoryGrantRow>> GetMemoryGrantsAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<MemoryGrantRow>>(
            [
                new(51, 1, 0, 1, now, now, 10, 10, 5, 1, 1, 10, 1, 10, 0, 1, 1, "RAW GRANT SQL"),
            ]);
        public Task<TempdbUsageRaw> GetTempdbUsageAsync(bool azureScoped, CancellationToken cancellationToken) =>
            Task.FromResult(new TempdbUsageRaw([], [], []));
        public Task<IReadOnlyList<FileIoRow>> GetFileIoStatsAsync(bool azureScoped, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<FileIoRow>>([]);
        public Task<IReadOnlyList<SchedulerRow>> GetSchedulerPressureAsync(bool includeIdealWorkersLimit, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<SchedulerRow>>([]);
        public Task<LogSpaceRow?> GetLogSpaceUsageAsync(CancellationToken cancellationToken) =>
            Task.FromResult<LogSpaceRow?>(null);
    }

    private sealed class FakeAtlasProbe(DateTimeOffset now) : IAtlasProbeExecutor
    {
        public int IdentityCalls { get; private set; }
        public Task<AtlasTargetIdentity> GetTargetIdentityAsync(CancellationToken cancellationToken)
        {
            IdentityCalls++;
            return Task.FromResult(new AtlasTargetIdentity(
                EnginePlatform.SqlServerOnPremises, "16.0", "Developer", "epoch", now));
        }
        public Task<IReadOnlyList<AtlasDatabaseIdentity>> DiscoverDatabasesAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<AtlasDatabaseIdentity>>(
                [new AtlasDatabaseIdentity("appdb", "ONLINE", 160, true)]);
        public Task<AtlasDatabaseProbeResult> CollectDatabaseAsync(
            string databaseName,
            AtlasProbeSelection selection,
            DateTimeOffset queryStoreWindowStart,
            DateTimeOffset queryStoreWindowEnd,
            CancellationToken cancellationToken) =>
            Task.FromResult(new AtlasDatabaseProbeResult(
                new AtlasDatabaseIdentity(databaseName, "ONLINE", 160, true),
                AtlasComponentOutcome.Success(
                    new AtlasSpaceResult("8192", "4096", "8192", "4096"), 1, "available"),
                AtlasComponentOutcome.Success(
                    new AtlasQueryStoreOptionsResult("ON", 0), 1, "available"),
                AtlasComponentOutcome.Success(
                    new AtlasQueryStoreWorkloadResult(
                        "1", "10", "5", "2", queryStoreWindowStart, queryStoreWindowEnd),
                    1, "available"),
                AtlasComponentOutcome.Success<IReadOnlyList<AtlasFileIoCounter>>([], 0, "available"),
                now,
                1));
    }

    private sealed class FakeCapabilityProbe(DateTimeOffset now) : IProbeExecutor
    {
        public int IdentityCalls { get; private set; }
        public Task<ServerIdentityResult> GetServerIdentityAsync(CancellationToken cancellationToken)
        {
            IdentityCalls++;
            return Task.FromResult(new ServerIdentityResult(
                null, "16.0.1000.1", null, null, 3, false, 4, 4, 4096, now.AddHours(-1)));
        }
        public Task<IReadOnlyList<DatabaseDiscoveryRow>> GetDatabaseDiscoveryAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<DatabaseDiscoveryRow>>(
                [new DatabaseDiscoveryRow(5, "appdb", "ONLINE", 160, true)]);
        public Task<QueryStoreOptionsRow?> GetQueryStoreOptionsAsync(string databaseName, CancellationToken cancellationToken) =>
            Task.FromResult<QueryStoreOptionsRow?>(
                new QueryStoreOptionsRow("READ_WRITE", "READ_WRITE", 0, 1, 100, "AUTO"));
        public Task<QueryStorePlanMetadataResult> GetQueryStorePlanMetadataAsync(string databaseName, CancellationToken cancellationToken) =>
            Task.FromResult(new QueryStorePlanMetadataResult(true, true, true, true));
        public Task<bool?> CheckServerPermissionAsync(string permission, CancellationToken cancellationToken) =>
            Task.FromResult<bool?>(true);
        public Task<bool?> CheckDatabasePermissionAsync(string databaseName, string permission, CancellationToken cancellationToken) =>
            Task.FromResult<bool?>(true);
        public Task<AzureResourceGovernanceRow?> GetAzureResourceGovernanceAsync(string databaseName, CancellationToken cancellationToken) =>
            Task.FromResult<AzureResourceGovernanceRow?>(null);
    }

    private sealed class FakeQueryIncremental(DateTimeOffset now) : IQueryStoreIncrementalSource
    {
        public int StateCalls { get; private set; }
        public int RawTextCalls { get; private set; }
        public int RawPlanCalls { get; private set; }
        public Task<IReadOnlyList<string>> DiscoverDatabasesAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<string>>(["appdb"]);
        public Task<QueryStoreDatabaseState> GetStateAsync(string databaseId, CancellationToken cancellationToken)
        {
            StateCalls++;
            return Task.FromResult(new QueryStoreDatabaseState(
                databaseId, QueryStoreCollectionState.ReadWrite, "epoch", now.AddDays(-1), now,
                "available", 16, 160, true, true, true, false));
        }
        public Task<QueryStoreFactPage> ReadPageAsync(
            string databaseId, QueryStoreFactKind kind, DateTimeOffset startInclusive,
            DateTimeOffset endExclusive, string? pageToken, int pageSize,
            CancellationToken cancellationToken)
        {
            IReadOnlyList<QueryStoreCollectedFact> facts = kind switch
            {
                QueryStoreFactKind.Identity =>
                [
                    new QueryIdentityFact(
                        "1", "10", "ctx", "0x1", now, false, false,
                        null, null, null, null),
                ],
                QueryStoreFactKind.Plan =>
                [
                    new QueryPlanFact(
                        "20", "1", "0xp", QueryPlanType.Compiled, null,
                        false, null, BigInteger.Zero, null, "16.0", "160", now),
                ],
                QueryStoreFactKind.Runtime =>
                [
                    new QueryRuntimeFact(new RuntimeStatInput(
                        "20", "interval", now.AddMinutes(-5), now,
                        QueryStoreExecutionType.Regular, "primary", 1, 1, 1, 1)),
                ],
                _ => [],
            };
            return Task.FromResult(new QueryStoreFactPage(kind, facts, null, false));
        }
        public Task<QueryTextPayload> ReadQueryTextAsync(string databaseId, string queryTextId, CancellationToken cancellationToken)
        {
            RawTextCalls++;
            return Task.FromResult(new QueryTextPayload("RAW QUERY", false, false));
        }
        public Task<string?> ReadPlanXmlAsync(string databaseId, string planId, CancellationToken cancellationToken)
        {
            RawPlanCalls++;
            return Task.FromResult<string?>("<ShowPlanXML />");
        }
    }

    private sealed class FakeCityProbe(DateTimeOffset now) : IDatabaseCityProbeExecutor
    {
        public int Calls { get; private set; }
        public Task<DatabaseCityProbePage> CollectPageAsync(
            string databaseName, int afterObjectId, int topN, CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(new DatabaseCityProbePage(
                [], [], DataStatus.Available, "available", now));
        }
    }

    private sealed class TrackingDisposable : IDisposable
    {
        public bool Disposed { get; private set; }
        public void Dispose() => Disposed = true;
    }
}
