using SqlSimCity.Collection.Catalog;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Collection.Tests.Catalog;
using SqlSimCity.Contracts.V1;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;
using System.Data;
using Azure.Identity;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Collection.Tests.Probes;

public sealed class SqlClientProbeExecutorTests
{
    [Theory]
    [InlineData("secret")]
    [InlineData("credential")]
    [InlineData("authentication")]
    public async Task ExpectedCredentialFailuresAreClassifiedWithoutLeakingDetails(string kind)
    {
        const string sensitive = "private credential detail";
        Exception failure = kind switch
        {
            "secret" => new SecretResolutionException(sensitive),
            "credential" => new CredentialUnavailableException(sensitive),
            "authentication" => new AuthenticationFailedException(sensitive),
            _ => throw new ArgumentOutOfRangeException(nameof(kind)),
        };
        var executor = new SqlClientProbeExecutor(
            new CapturingConnectionFactory { Failure = failure }, BuildProfile("original"), ProbeCatalog.Load());

        var classified = await Assert.ThrowsAsync<ProbeAuthenticationException>(
            () => executor.GetServerIdentityAsync(CancellationToken.None));

        Assert.Same(failure, classified.InnerException);
        Assert.DoesNotContain(sensitive, classified.Reason, StringComparison.Ordinal);
        Assert.Null(classified.SqlErrorNumber);
    }

    [Fact]
    public async Task DatabaseScopedCallsOpenOnlyTheRequestedDatabaseProfiles()
    {
        var factory = new CapturingConnectionFactory();
        var executor = new SqlClientProbeExecutor(factory, BuildProfile("original"), ProbeCatalog.Load());

        await Assert.ThrowsAsync<StopAfterCaptureException>(
            () => executor.GetQueryStoreOptionsAsync("DB-A", CancellationToken.None));
        await Assert.ThrowsAsync<StopAfterCaptureException>(
            () => executor.GetQueryStorePlanMetadataAsync("DB-B", CancellationToken.None));
        await Assert.ThrowsAsync<StopAfterCaptureException>(
            () => executor.CheckDatabasePermissionAsync("DB-A", "VIEW DATABASE STATE", CancellationToken.None));
        await Assert.ThrowsAsync<StopAfterCaptureException>(
            () => executor.GetAzureResourceGovernanceAsync("DB-B", CancellationToken.None));

        Assert.Equal(["DB-A", "DB-B", "DB-A", "DB-B"], factory.OpenedProfiles.Select(p => p.InitialDatabase));
    }

    [Fact]
    public async Task MasterAndServerCallsUseTheirDeclaredProfiles()
    {
        var factory = new CapturingConnectionFactory();
        var executor = new SqlClientProbeExecutor(factory, BuildProfile("original"), ProbeCatalog.Load());

        await Assert.ThrowsAsync<StopAfterCaptureException>(
            () => executor.GetServerIdentityAsync(CancellationToken.None));
        await Assert.ThrowsAsync<StopAfterCaptureException>(
            () => executor.GetDatabaseDiscoveryAsync(CancellationToken.None));
        await Assert.ThrowsAsync<StopAfterCaptureException>(
            () => executor.CheckServerPermissionAsync("VIEW SERVER STATE", CancellationToken.None));

        Assert.Equal(["master", "master", "original"], factory.OpenedProfiles.Select(p => p.InitialDatabase));
    }

    [Fact]
    public async Task ConfiguredAzureSqlUsesContainedDatabaseForMasterScopedMetadata()
    {
        var factory = new CapturingConnectionFactory();
        var executor = new SqlClientProbeExecutor(
            factory,
            BuildProfile("contained-db"),
            ProbeCatalog.Load(),
            EnginePlatform.AzureSqlDatabase);

        await Assert.ThrowsAsync<StopAfterCaptureException>(
            () => executor.GetServerIdentityAsync(CancellationToken.None));
        await Assert.ThrowsAsync<StopAfterCaptureException>(
            () => executor.GetDatabaseDiscoveryAsync(CancellationToken.None));

        Assert.All(
            factory.OpenedProfiles,
            profile => Assert.Equal("contained-db", profile.InitialDatabase));
    }

    [Fact]
    public async Task InvocationRejectsManifestScopeMismatchBeforeOpening()
    {
        var probe = FakeProbeCatalogResourceSource.ValidProbeJson(
            id: "querystore.options_2019",
            connectionScope: "server");
        var catalog = ProbeCatalog.Load(new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probe}]"))
            .With("sql/probes/test/probe.sql", "SELECT 1;"));
        var factory = new CapturingConnectionFactory();
        var executor = new SqlClientProbeExecutor(factory, BuildProfile("original"), catalog);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => executor.GetQueryStoreOptionsAsync("DB-A", CancellationToken.None));

        Assert.Empty(factory.OpenedProfiles);
    }

    [Fact]
    public async Task InvocationRejectsMissingOrUndeclaredParametersBeforeOpening()
    {
        const string parameter = """
            [{"name":"@Other","sqlDbType":"Int","required":true,"description":"required"}]
            """;
        var probe = FakeProbeCatalogResourceSource.ValidProbeJson(
            id: "capability.server_permission_check",
            parametersJson: parameter);
        var catalog = ProbeCatalog.Load(new FakeProbeCatalogResourceSource()
            .With("sql/manifest.json", FakeProbeCatalogResourceSource.BaseManifestWithProbes($"[{probe}]"))
            .With("sql/probes/test/probe.sql", "SELECT @Other;"));
        var factory = new CapturingConnectionFactory();
        var executor = new SqlClientProbeExecutor(factory, BuildProfile("original"), catalog);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => executor.CheckServerPermissionAsync("VIEW SERVER STATE", CancellationToken.None));

        Assert.Empty(factory.OpenedProfiles);
    }

    [Fact]
    public void WorkloadParametersUseManifestNamesAndSqlTypes()
    {
        var probe = ProbeCatalog.Load().Get("querystore.database_workload_summary_2022");
        var start = new DateTimeOffset(2026, 8, 16, 12, 0, 0, TimeSpan.Zero);
        var end = start.AddDays(1);

        var parameters = SqlClientProbeExecutor.BuildParameters(
            probe,
            new Dictionary<string, object?> { ["@StartTime"] = start, ["@EndTime"] = end });

        Assert.Equal(["@StartTime", "@EndTime"], parameters.Select(parameter => parameter.ParameterName));
        Assert.All(parameters, parameter => Assert.Equal(SqlDbType.DateTimeOffset, parameter.SqlDbType));
        Assert.Equal([start, end], parameters.Select(parameter => parameter.Value));
        Assert.Throws<InvalidOperationException>(() =>
            SqlClientProbeExecutor.BuildParameters(
                probe,
                new Dictionary<string, object?> { ["@StartTime"] = start }));
        Assert.Throws<InvalidOperationException>(() =>
            SqlClientProbeExecutor.BuildParameters(
                probe,
                new Dictionary<string, object?>
                {
                    ["@StartTime"] = start,
                    ["@EndTime"] = end,
                    ["@SqlText"] = "SELECT secret",
                }));
    }

    private static ConnectionProfile BuildProfile(string database) => new(
        new ConnectionProfileId("test-profile"),
        new ServerAddress("localhost", port: 1433),
        database,
        new ConnectionTimeouts(5, 10),
        new PoolBounds(0, 5),
        EncryptionPolicy.Mandatory,
        new KerberosAuthenticationStrategy());

    private sealed class StopAfterCaptureException : Exception;

    private sealed class CapturingConnectionFactory : ISqlConnectionFactory
    {
        public List<ConnectionProfile> OpenedProfiles { get; } = [];
        public Exception? Failure { get; init; }

        public Task<SqlConnectionOpenResult> OpenAsync(ConnectionProfile profile, CancellationToken cancellationToken)
        {
            OpenedProfiles.Add(profile);
            throw Failure ?? new StopAfterCaptureException();
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
