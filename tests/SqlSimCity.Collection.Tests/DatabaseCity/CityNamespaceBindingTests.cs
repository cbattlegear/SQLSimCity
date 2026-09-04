using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.Tests.DatabaseCity;

public sealed class CityNamespaceBindingTests
{
    [Theory]
    [InlineData("SmokeCity", "connected-smoke/database/SmokeCity", "SmokeCity")]
    [InlineData("Sales", "connected-smoke/database/Sales", "sales")]
    [InlineData("space / name", "connected-smoke/database/space%20%2F%20name", "space / name")]
    [InlineData("ContainedDb", "connected-smoke/resource/subscription%2Fdatabase-resource", "ContainedDb")]
    public async Task MapsBoundCatalogIdentityWithoutChangingPublicOwner(string name, string id, string queryNamespace)
    {
        var probe = new Probe();
        var queries = new Namespaces(name, queryNamespace);
        var source = new ConnectedDatabaseCitySource(new Atlas("connected-smoke", Database(id, name)),
            probe, new QueryStoreCityAttribution(queries), targetId: "connected-smoke");
        var page = await source.GetDatabaseAsync(id, DatabaseCityMetric.Cpu, 1, null, CancellationToken.None);
        Assert.NotNull(page);
        Assert.Equal(id, page.DatabaseId);
        Assert.Equal(queryNamespace, page.QueryStoreDatabaseId);
        Assert.Equal(name, Assert.Single(probe.Databases));
        Assert.Equal(1, queries.Reads);
    }

    [Theory]
    [InlineData("foreign", "connected-smoke/database/SmokeCity", "SmokeCity")]
    [InlineData("connected-smoke", "foreign/database/SmokeCity", "SmokeCity")]
    [InlineData("connected-smoke", "connected-smoke-extra/database/SmokeCity", "SmokeCity")]
    [InlineData("connected-smoke", "connected-smoke/database/different", "SmokeCity")]
    [InlineData("connected-smoke", "SmokeCity", "SmokeCity")]
    [InlineData("connected-smoke", "connected-smoke/resource/", "SmokeCity")]
    public async Task RejectsForeignOrUnboundCatalogRowsBeforeProbing(string atlasTarget, string id, string name)
    {
        var probe = new Probe();
        var source = new ConnectedDatabaseCitySource(new Atlas(atlasTarget, Database(id, name)),
            probe, targetId: "connected-smoke");
        Assert.Null(await source.GetDatabaseAsync(id, DatabaseCityMetric.Cpu, 1, null, CancellationToken.None));
        Assert.Empty(probe.Databases);
    }

    [Theory]
    [InlineData("connected-smoke/resource/another", "SmokeCity")]
    [InlineData("foreign/database/SmokeCity", "SmokeCity")]
    [InlineData("connected-smoke/database/smokecity", "smokecity")]
    [InlineData("connected-smoke/database/SmokeCity", "SmokeCity")]
    public async Task RejectsSameNameOrDuplicateIdentityAmbiguity(string otherId, string otherName)
    {
        const string id = "connected-smoke/database/SmokeCity";
        var probe = new Probe();
        var source = new ConnectedDatabaseCitySource(
            new Atlas("connected-smoke", Database(id, "SmokeCity"), Database(otherId, otherName)),
            probe, targetId: "connected-smoke");
        Assert.Null(await source.GetDatabaseAsync(id, DatabaseCityMetric.Cpu, 1, null, CancellationToken.None));
        Assert.Empty(probe.Databases);
    }

    [Fact]
    public async Task UnconfiguredTargetDoesNotClaimAQueryStoreNamespace()
    {
        const string id = "connected-smoke/database/SmokeCity";
        var source = new ConnectedDatabaseCitySource(
            new Atlas("connected-smoke", Database(id, "SmokeCity")), new Probe(),
            new QueryStoreCityAttribution(new Namespaces("SmokeCity", "SmokeCity")));
        var page = await source.GetDatabaseAsync(id, DatabaseCityMetric.Cpu, 1, null, CancellationToken.None);
        Assert.NotNull(page);
        Assert.Null(page.QueryStoreDatabaseId);
    }

    [Fact]
    public async Task CatalogPermissionFailureDoesNotGuessAnUnreadNamespace()
    {
        const string id = "connected-smoke/database/SmokeCity";
        var source = new ConnectedDatabaseCitySource(
            new Atlas("connected-smoke", Database(id, "SmokeCity")), new Probe(fail: true),
            targetId: "connected-smoke");
        var page = await source.GetDatabaseAsync(id, DatabaseCityMetric.Cpu, 1, null, CancellationToken.None);
        Assert.NotNull(page);
        Assert.Null(page.QueryStoreDatabaseId);
        Assert.Equal(DataStatus.PermissionDenied, page.Evidence.Status);
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("unavailable")]
    [InlineData("foreign")]
    [InlineData("mixed-case")]
    public async Task UnprovenPublishedNamespaceIsNotReplacedWithCatalogName(string mode)
    {
        const string id = "connected-smoke/database/Sales";
        string[] values = mode switch
        {
            "empty" or "unavailable" => [],
            "foreign" => ["inventory"],
            "mixed-case" => ["Sales", "sales"],
            _ => throw new ArgumentOutOfRangeException(nameof(mode)),
        };
        var queries = new Namespaces("Sales", values) { Fail = mode == "unavailable" };
        var source = new ConnectedDatabaseCitySource(
            new Atlas("connected-smoke", Database(id, "Sales")), new Probe(),
            new QueryStoreCityAttribution(queries), targetId: "connected-smoke");
        var page = await source.GetDatabaseAsync(id, DatabaseCityMetric.Cpu, 1, null, CancellationToken.None);
        Assert.NotNull(page);
        Assert.Null(page.QueryStoreDatabaseId);
        Assert.Equal(1, queries.Reads);
    }

    private static readonly EvidenceV1 Evidence =
        new(EvidenceSource.CatalogSnapshot, DataStatus.Available, DateTimeOffset.UnixEpoch, null, "test");

    private static DatabaseAtlasItemV1 Database(string id, string name) => new(
        id, name, new ByteMeasurementV1(null, MeasurementStatus.Unknown, "test", Evidence),
        new ByteMeasurementV1(null, MeasurementStatus.Unknown, "test", Evidence),
        new LiveActivityV1(null, null, null, null, Evidence),
        new QueryStoreHistoryV1(null, null, null, null, null, QueryStoreCapability.Unknown,
            QueryStoreHealth.Unknown, "test", Evidence));

    private sealed class Atlas(string targetId, params DatabaseAtlasItemV1[] databases) : IAtlasSnapshotSource
    {
        public AtlasSnapshotV1 GetCurrent() => new(
            "1.0", "snapshot", new AtlasTargetV1(targetId, targetId, "SQL Server"),
            DateTimeOffset.UnixEpoch, databases, []);
    }

    private sealed class Probe(bool fail = false) : IDatabaseCityProbeExecutor
    {
        public List<string> Databases { get; } = [];

        public Task<DatabaseCityProbePage> CollectPageAsync(
            string databaseName, int afterObjectId, int topN, CancellationToken cancellationToken)
        {
            Databases.Add(databaseName);
            if (fail)
                throw new ProbePermissionDeniedException("Denied.", null, null);
            return Task.FromResult(new DatabaseCityProbePage(
                [], [], DataStatus.Available, "test", DateTimeOffset.UnixEpoch, TotalObjects: "0"));
        }
    }

    private sealed class Namespaces(string catalogName, params string[] namespaces) : IQueryStoreHistorySource
    {
        public int Reads { get; private set; }
        public bool Fail { get; init; }

        public Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(
            string? databaseId, string metric, int pageSize, string? pageToken, CancellationToken cancellationToken)
        {
            Reads++;
            Assert.Equal(catalogName, databaseId);
            if (Fail)
                throw new InvalidDataException("No published scope.");
            var evidence = new QueryStoreEvidenceV1(
                QueryStoreSource.QueryStore, DataStatus.Available, DateTimeOffset.UnixEpoch, null, "test", "test");
            return Task.FromResult(new PageV1<QueryFamilySummaryV1>("1.0",
                namespaces.Select(value => new QueryFamilySummaryV1(
                    "family:" + value, value, "hash", null,
                    new QueryTextDescriptorV1(QueryTextAvailability.Missing, null, null, "test"), [],
                    "1", "1", "1", "1", "1", DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, evidence)).ToArray(),
                null, pageSize, null) { Evidence = evidence });
        }

        public Task<QueryFamilyDetailV1?> GetFamilyAsync(string familyId, CancellationToken cancellationToken) =>
            Task.FromResult<QueryFamilyDetailV1?>(null);
        public Task<NormalizedShowplanV1?> GetPlanAsync(string planId, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("No plan detail was supplied.");
        public Task<PlanComparisonV1?> ComparePlansAsync(string leftPlanId, string rightPlanId, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("No comparison should be requested.");
        public Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken) =>
            throw new InvalidOperationException("Namespace resolution must not add a status read.");
    }
}
