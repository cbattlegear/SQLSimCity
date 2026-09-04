using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Time.Testing;
using SqlSimCity.Api;
using SqlSimCity.Collection.Atlas;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Api.Tests;

public sealed class ConnectedCapabilitiesTests
{
    private static readonly DateTimeOffset ObservedAt = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);
    private static readonly string[] DatabaseNames = ["app", "restricted"];
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CompositionRootUsesConnectedNegotiationAndCachesReads(bool liveOnly)
    {
        var clock = new FakeTimeProvider(ObservedAt);
        var probes = new CapabilityProbes();
        await using var factory = Factory(probes, clock, liveOnly);
        using var client = factory.CreateClient();
        var source = Assert.IsType<ConnectedCapabilitiesSource>(factory.Services.GetRequiredService<ICapabilitiesSource>());
        Assert.Contains(source, factory.Services.GetServices<IHostedService>());
        await WaitForSnapshotAsync(source, ObservedAt);

        using var response = await client.GetAsync(new Uri("/api/v1/capabilities", UriKind.Relative));
        var snapshot = await response.Content.ReadFromJsonAsync<CapabilitiesSnapshotV1>(JsonOptions);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        var target = Assert.Single(Assert.IsType<CapabilitiesSnapshotV1>(snapshot).Targets);
        Assert.Equal("monitored-target", target.TargetId);
        Assert.Equal(ObservedAt, target.SourceTimestamp);
        Assert.Equal(ObservedAt, target.Platform.Evidence.SourceTimestamp);
        Assert.Equal("16.0.1000.1", target.Platform.ProductVersion);
        Assert.Equal(CapabilityState.Supported, target.Waits.State);
        Assert.Equal(CapabilityState.PermissionDenied, target.QueryStoreByDatabase["restricted"].Availability);
        Assert.All(probes.RequestedDatabases, name => Assert.Contains(name, DatabaseNames));
        if (!liveOnly)
            Assert.Equal(DatabaseNames, target.QueryStoreByDatabase.Keys.Order().ToArray());
        var calls = probes.Calls;
        for (var i = 0; i < 3; i++)
            _ = await client.GetStringAsync("/api/v1/capabilities");
        Assert.Equal(calls, probes.Calls);
        Assert.Equal("{\"status\":\"healthy\"}", await client.GetStringAsync("/healthz"));
        Assert.Equal("{\"status\":\"ready\"}", await client.GetStringAsync("/readyz"));
        using var retired = await client.GetAsync(new Uri("/api/v1/findings/status", UriKind.Relative));
        Assert.Equal(HttpStatusCode.Gone, retired.StatusCode);
    }

    [Theory]
    [InlineData(false, CapabilityState.Unavailable)]
    [InlineData(true, CapabilityState.PermissionDenied)]
    public async Task FailedNegotiationPublishesExplicitFailureAndRecoveryPreservesObservationTime(
        bool denied, CapabilityState expected)
    {
        var clock = new FakeTimeProvider(ObservedAt);
        var probes = new CapabilityProbes();
        await using var factory = Factory(probes, clock);
        using var client = factory.CreateClient();
        var source = Assert.IsType<ConnectedCapabilitiesSource>(factory.Services.GetRequiredService<ICapabilitiesSource>());
        await WaitForSnapshotAsync(source, ObservedAt);
        probes.Failure = denied
            ? new ProbePermissionDeniedException("Permission denied.", 297, 14)
            : new ProbeTimeoutException("Probe timed out.", -2, 11);
        clock.Advance(TimeSpan.FromMinutes(2));
        await WaitForSnapshotAsync(source, clock.GetUtcNow());
        var failed = Assert.Single(source.GetCurrent().Targets);
        Assert.Equal(expected, failed.Platform.Evidence.State);
        Assert.NotEqual(CapabilityState.Supported, failed.Waits.State);
        Assert.Equal(expected, failed.QueryStoreByDatabase["app"].Availability);
        Assert.Equal(clock.GetUtcNow(), failed.Platform.Evidence.SourceTimestamp);
        Assert.DoesNotContain("fixture", JsonSerializer.Serialize(failed), StringComparison.OrdinalIgnoreCase);

        probes.Failure = null;
        clock.Advance(TimeSpan.FromMinutes(2));
        await WaitForSnapshotAsync(source, clock.GetUtcNow());
        Assert.Equal(CapabilityState.Supported, Assert.Single(source.GetCurrent().Targets).Waits.State);
        var observed = source.GetCurrent();
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Same(observed, source.GetCurrent());
    }

    [Theory]
    [InlineData("contained.database.windows.net", null, "contained-db")]
    [InlineData("private-alias.example.test", "AzureSqlDatabase", "contained-db")]
    [InlineData("managed.database.windows.net", "AzureSqlManagedInstance", "master")]
    public async Task FieldConfiguredAzureContextUsesContainedDatabaseAndAuthFailureDoesNotStopHost(
        string host, string? platform, string metadataDatabase)
    {
        var clock = new FakeTimeProvider(ObservedAt);
        var connection = new AuthenticationFailureConnectionFactory();
        await using var factory = Factory(new CapabilityProbes(), clock)
            .WithWebHostBuilder(builder =>
            {
                builder.UseSetting("Atlas:Connection:Host", host);
                builder.UseSetting("Atlas:Connection:InitialDatabase", "contained-db");
                if (platform is not null)
                    builder.UseSetting("Atlas:Platform", platform);
                builder.ConfigureTestServices(services =>
                {
                    services.RemoveAll<IProbeExecutor>();
                    services.AddSingleton<IProbeExecutor>(provider =>
                    {
                        var target = provider.GetRequiredService<ConnectedCapabilityTarget>();
                        return new SqlClientProbeExecutor(connection, target.Profile,
                            provider.GetRequiredService<SqlSimCity.Collection.Catalog.ProbeCatalog>(), target.Platform);
                    });
                });
            });
        using var client = factory.CreateClient();
        var source = Assert.IsType<ConnectedCapabilitiesSource>(factory.Services.GetRequiredService<ICapabilitiesSource>());
        await WaitForSnapshotAsync(source, ObservedAt);
        Assert.NotEmpty(connection.OpenedDatabases);
        Assert.All(connection.OpenedDatabases.Take(2), database => Assert.Equal(metadataDatabase, database));
        Assert.All(connection.OpenedDatabases.Skip(2), database => Assert.Equal("contained-db", database));
        var snapshot = Assert.Single(source.GetCurrent().Targets);
        Assert.Equal(CapabilityState.Unavailable, snapshot.Platform.Evidence.State);
        Assert.DoesNotContain("private secret", JsonSerializer.Serialize(snapshot), StringComparison.Ordinal);
        Assert.False(factory.Services.GetRequiredService<IHostApplicationLifetime>().ApplicationStopping.IsCancellationRequested);
        Assert.Equal("{\"status\":\"healthy\"}", await client.GetStringAsync("/healthz"));
        var attempts = connection.OpenedDatabases.Count;
        clock.Advance(TimeSpan.FromMinutes(2));
        await WaitForSnapshotAsync(source, clock.GetUtcNow());
        Assert.True(connection.OpenedDatabases.Count > attempts);
        Assert.False(factory.Services.GetRequiredService<IHostApplicationLifetime>().ApplicationStopping.IsCancellationRequested);
    }

    [Theory]
    [InlineData("Unknown")]
    [InlineData("Unsupported")]
    [InlineData("999")]
    public void InvalidAtlasRoutingPlatformFailsBeforeServing(string platform)
    {
        using var factory = Factory(new CapabilityProbes(), new FakeTimeProvider(ObservedAt))
            .WithWebHostBuilder(builder => builder.UseSetting("Atlas:Platform", platform));
        var error = Assert.Throws<InvalidOperationException>(() => factory.CreateClient());
        Assert.Contains("Atlas:Platform must be", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SnapshotAndNegotiationWorkRespectTheAtlasDatabaseBound()
    {
        var clock = new FakeTimeProvider(ObservedAt);
        var probes = new CapabilityProbes
        {
            Databases = Enumerable.Range(1, 110)
                .Select(index => new DatabaseDiscoveryRow(index, $"db{index}", "ONLINE", 160, true)).ToArray(),
        };
        using var source = new ConnectedCapabilitiesSource(
            new ConnectedCapabilityTarget("target", Profile(), [], TimeSpan.FromMinutes(1)),
            probes, clock);

        await source.RefreshAsync(CancellationToken.None);

        var target = Assert.Single(source.GetCurrent().Targets);
        Assert.Equal(AtlasCollectionOptions.MaximumDatabases, target.Databases.Count);
        Assert.Equal(AtlasCollectionOptions.MaximumDatabases, target.QueryStoreByDatabase.Count);
        Assert.Equal(AtlasCollectionOptions.MaximumDatabases, probes.RequestedDatabases.Count);
        Assert.Equal(1, probes.IdentityCalls);
        Assert.Equal(1, probes.DiscoveryCalls);
        Assert.Equal(2, probes.ServerPermissionCalls);
        Assert.Equal(2 * AtlasCollectionOptions.MaximumDatabases, probes.DatabasePermissionCalls);
        Assert.Contains("bounded to 100", target.DatabaseDiscovery.Reason, StringComparison.Ordinal);

        clock.Advance(TimeSpan.FromMinutes(1));
        await source.RefreshAsync(CancellationToken.None);
        Assert.Equal(2, probes.IdentityCalls);
        Assert.Equal(2, probes.DiscoveryCalls);
        Assert.Equal(4, probes.ServerPermissionCalls);
        Assert.Equal(4 * AtlasCollectionOptions.MaximumDatabases, probes.DatabasePermissionCalls);
        Assert.Equal(clock.GetUtcNow(), Assert.Single(source.GetCurrent().Targets).SourceTimestamp);
    }

    [Fact]
    public async Task PendingAndCancelledNegotiationNeverPublishInventedEvidence()
    {
        var clock = new FakeTimeProvider(ObservedAt);
        var probes = new CapabilityProbes();
        using var source = new ConnectedCapabilitiesSource(
            new ConnectedCapabilityTarget("target", Profile(), [], TimeSpan.FromMinutes(1)),
            probes, clock);
        var pending = Assert.Single(source.GetCurrent().Targets);
        Assert.Equal("target", pending.TargetId);
        Assert.Equal(EnginePlatform.Unknown, pending.Platform.Platform);
        Assert.Equal(CapabilityState.NotProbed, pending.Waits.State);
        Assert.Null(pending.Waits.Evidence.SourceTimestamp);
        var before = source.GetCurrent();
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => source.RefreshAsync(cancellation.Token));
        Assert.Same(before, source.GetCurrent());
    }

    private static WebApplicationFactory<ApiAssemblyMarker> Factory(
        CapabilityProbes probes, FakeTimeProvider clock, bool liveOnly = false) =>
        new WebApplicationFactory<ApiAssemblyMarker>().WithWebHostBuilder(builder =>
        {
            if (liveOnly)
            {
                builder.UseSetting("LiveIncidents:Mode", "Connected");
                builder.UseSetting("LiveIncidents:Connection:TargetId", "monitored-target");
                builder.UseSetting("LiveIncidents:Connection:DisplayName", "Monitored target");
                builder.UseSetting("LiveIncidents:Connection:Platform", "SqlServerOnPremises");
                builder.UseSetting("LiveIncidents:Connection:Server:Host", "never-contact.example.test");
                builder.UseSetting("LiveIncidents:Connection:Database", "restricted");
                builder.UseSetting("LiveIncidents:Connection:Authentication:Mode", "Kerberos");
            }
            else
            {
                builder.UseSetting("Atlas:Mode", "Connected");
                builder.UseSetting("Atlas:TargetId", "monitored-target");
                builder.UseSetting("Atlas:Connection:Host", "never-contact.example.test");
                builder.UseSetting("Atlas:Connection:InitialDatabase", "app");
                builder.UseSetting("Atlas:Connection:Authentication:Mode", "Kerberos");
            }
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<IProbeExecutor>();
                services.AddSingleton<IProbeExecutor>(probes);
                services.RemoveAll<IAtlasProbeExecutor>();
                services.AddSingleton<IAtlasProbeExecutor, DisconnectedAtlasProbes>();
                services.RemoveAll<ILiveIncidentCollector>();
                services.AddSingleton<ILiveIncidentCollector, FixtureLiveIncidentCollector>();
                services.RemoveAll<TimeProvider>();
                services.AddSingleton<TimeProvider>(clock);
            });
        });

    private static async Task WaitForSnapshotAsync(ConnectedCapabilitiesSource source, DateTimeOffset generatedAt)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (source.GetCurrent().GeneratedAt != generatedAt)
            await Task.Delay(10, timeout.Token);
        // Allow the hosted cycle to register its next timer before advancing the test clock.
        await Task.Delay(30);
    }

    private static ConnectionProfile Profile() => new(
        new ConnectionProfileId("test"), new ServerAddress("never-contact.example.test"), "app",
        new ConnectionTimeouts(5, 5), new PoolBounds(0, 2), EncryptionPolicy.Mandatory,
        new KerberosAuthenticationStrategy());

    private sealed class CapabilityProbes : IProbeExecutor
    {
        public ProbeExecutionException? Failure { get; set; }
        public int Calls { get; private set; }
        public int IdentityCalls { get; private set; }
        public int DiscoveryCalls { get; private set; }
        public int ServerPermissionCalls { get; private set; }
        public int DatabasePermissionCalls { get; private set; }
        public List<string> RequestedDatabases { get; } = [];
        public IReadOnlyList<DatabaseDiscoveryRow> Databases { get; init; } =
            [new(5, "app", "ONLINE", 160, true), new(6, "restricted", "ONLINE", 160, true)];

        private Task<T> Result<T>(T value, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Calls++;
            return Failure is null ? Task.FromResult(value) : Task.FromException<T>(Failure);
        }

        public Task<ServerIdentityResult> GetServerIdentityAsync(CancellationToken cancellationToken)
        {
            IdentityCalls++;
            return Result(new ServerIdentityResult(null, "16.0.1000.1", null, "Developer", 3, false, 2, 2, null, null), cancellationToken);
        }

        public Task<IReadOnlyList<DatabaseDiscoveryRow>> GetDatabaseDiscoveryAsync(CancellationToken cancellationToken)
        {
            DiscoveryCalls++;
            return Result(Databases, cancellationToken);
        }

        public Task<QueryStoreOptionsRow?> GetQueryStoreOptionsAsync(string databaseName, CancellationToken cancellationToken)
        {
            RequestedDatabases.Add(databaseName);
            return databaseName == "restricted" && Failure is null
                ? Task.FromException<QueryStoreOptionsRow?>(new ProbePermissionDeniedException("Permission denied.", 297, 14))
                : Result<QueryStoreOptionsRow?>(new("READ_WRITE", "READ_WRITE", 0, 1, 100, "AUTO"), cancellationToken);
        }

        public Task<QueryStorePlanMetadataResult> GetQueryStorePlanMetadataAsync(string databaseName, CancellationToken cancellationToken) =>
            Result(new QueryStorePlanMetadataResult(false, false, false, false), cancellationToken);
        public Task<bool?> CheckServerPermissionAsync(string permission, CancellationToken cancellationToken)
        {
            ServerPermissionCalls++;
            return Result<bool?>(true, cancellationToken);
        }
        public Task<bool?> CheckDatabasePermissionAsync(string databaseName, string permission, CancellationToken cancellationToken)
        {
            DatabasePermissionCalls++;
            return Result<bool?>(true, cancellationToken);
        }
        public Task<AzureResourceGovernanceRow?> GetAzureResourceGovernanceAsync(string databaseName, CancellationToken cancellationToken) =>
            Result<AzureResourceGovernanceRow?>(null, cancellationToken);
    }

    private sealed class DisconnectedAtlasProbes : IAtlasProbeExecutor
    {
        public Task<AtlasTargetIdentity> GetTargetIdentityAsync(CancellationToken cancellationToken) =>
            Task.FromException<AtlasTargetIdentity>(new ProbeTimeoutException("Atlas not connected in this test.", -2, 11));
        public Task<IReadOnlyList<AtlasDatabaseIdentity>> DiscoverDatabasesAsync(CancellationToken cancellationToken) =>
            throw new InvalidOperationException("No atlas database should be probed.");
        public Task<AtlasDatabaseProbeResult> CollectDatabaseAsync(
            string databaseName, AtlasProbeSelection selection, DateTimeOffset queryStoreWindowStart,
            DateTimeOffset queryStoreWindowEnd, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("No atlas database should be probed.");
    }

    private sealed class AuthenticationFailureConnectionFactory : ISqlConnectionFactory
    {
        public List<string> OpenedDatabases { get; } = [];
        public Task<SqlConnectionOpenResult> OpenAsync(ConnectionProfile profile, CancellationToken cancellationToken)
        {
            OpenedDatabases.Add(profile.InitialDatabase);
            throw new SecretResolutionException("private secret");
        }
        public Task InvalidateSqlLoginProfileAsync(ConnectionProfile profile, CancellationToken cancellationToken = default) =>
            Task.CompletedTask;
        public Task InvalidateEntraProfileAsync(ConnectionProfile profile, CancellationToken cancellationToken = default) =>
            Task.CompletedTask;
        public Task RetryPendingCleanupAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public void Dispose() { }
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
