using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.Tests.DatabaseCity;

public sealed class ConnectedDatabaseCitySourceTests
{
    [Fact]
    public async Task PagesParentsBeforeIndexExpansionAndSeparatesEvidence()
    {
        var source = new ConnectedDatabaseCitySource(new FakeAtlasSource(), new FakeCityProbeExecutor());

        var page = await source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 1, null, CancellationToken.None);

        Assert.NotNull(page);
        var item = Assert.Single(page.Objects);
        Assert.Equal("81920", item.ReservedBytes);
        Assert.Equal("40960", item.UsedBytes);
        Assert.Equal("5", item.DirectActivity.TotalOperations);
        Assert.Equal(EvidenceSource.LiveDmvCumulative, item.DirectActivity.Evidence.Source);
        Assert.Equal(EvidenceSource.NotProbed, item.AttributedExposure.Evidence.Source);
        Assert.Null(item.DirectActivity.ResetEpochToken);
        Assert.All(item.Indexes, index => Assert.Null(index.DirectActivity.ResetEpochToken));
        Assert.Single(item.Indexes);
        Assert.NotNull(page.NextPageToken);
        Assert.Null(page.OtherWorkload.TotalCpuMicroseconds);
        Assert.Equal("1", Assert.Single(page.Schemas).ObjectCount);

        // The whole database's object count, not this page's: the city grid is sized from it, so a
        // null here would make every later page reshuffle the buildings already on screen.
        Assert.Equal("7", page.TotalObjects);
    }

    /// <summary>
    /// A probe that could not run leaves the count unknown. Reporting zero would say the database
    /// is empty, which is a measurement the failed probe never made.
    /// </summary>
    [Fact]
    public async Task TotalObjectsStaysUnknownWhenTheInventoryProbeFails()
    {
        var source = new ConnectedDatabaseCitySource(new FakeAtlasSource(), new FailingCityProbeExecutor());

        var page = await source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 1, null, CancellationToken.None);

        Assert.Null(page!.TotalObjects);
        Assert.Empty(page.Objects);
    }

    [Fact]
    public async Task SummaryDoesNotClaimAtlasAllocationAsObjectReservedBytes()
    {
        var source = new ConnectedDatabaseCitySource(new FakeAtlasSource(), new FakeCityProbeExecutor());

        var summaries = await source.GetSummariesAsync(CancellationToken.None);

        Assert.Null(Assert.Single(summaries.Databases).ReservedBytes);
    }

    [Fact]
    public async Task IndexlessParentRemainsUnknownAndDoesNotEndPaging()
    {
        var source = new ConnectedDatabaseCitySource(new FakeAtlasSource(), new IndexlessCityProbeExecutor());

        var page = await source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 1, null, CancellationToken.None);

        var item = Assert.Single(page!.Objects);
        Assert.Equal("target/database/sales/object/10", item.ObjectId);
        Assert.Equal(MeasurementStatus.Unknown, item.SizeStatus);
        Assert.Empty(item.Indexes);
        Assert.NotNull(page.NextPageToken);
    }

    [Fact]
    public async Task PropagatesCallerCancellationBeforeReading()
    {
        var source = new ConnectedDatabaseCitySource(new FakeAtlasSource(), new FakeCityProbeExecutor());
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 1, null,
            new CancellationToken(canceled: true)));
    }

    [Fact]
    public async Task CatalogContinuationPinsRecentWindowAcrossFamiliesAndPagesButNotANewWalk()
    {
        var started = new DateTimeOffset(2026, 8, 17, 17, 0, 0, TimeSpan.Zero).AddTicks(1234);
        var probeClock = new AdvancingClock(started, TimeSpan.FromMinutes(2));
        var attributionClock = new AdvancingClock(started, TimeSpan.FromMilliseconds(1));
        var probe = new PagingCityProbeExecutor(probeClock);
        var queryStore = new FakeQueryStore();
        foreach (var (name, wait, category) in new[] { ("Customer", "11", "CPU"), ("OrderHeader", "22", "Lock") })
        {
            queryStore.AddFamily(name, "1", "1",
                [FakeQueryStore.SizedPlan(name, new FakeQueryStore.PlanNode(
                    FakeQueryStore.Reference(table: name), EstimatedCpu: 1))],
                waitMilliseconds: wait, runtimeIntervals:
                [
                    new(started.AddMinutes(-14), started.AddMinutes(-13), WaitMilliseconds: wait,
                        PlanId: name, WaitCategories: new Dictionary<string, string> { [category] = wait }),
                ]);
        }
        ConnectedDatabaseCitySource Source() => new(
            new FakeAtlasSource(), probe, new QueryStoreCityAttribution(queryStore, timeProvider: attributionClock));

        var first = (await Source().GetDatabaseAsync(
            FakeQueryStore.DatabaseId, DatabaseCityMetric.Cpu, 1, null, default))!;
        Assert.NotNull(first.NextPageToken);
        var second = (await Source().GetDatabaseAsync(
            FakeQueryStore.DatabaseId, DatabaseCityMetric.Cpu, 1, first.NextPageToken, default))!;
        Assert.Null(second.NextPageToken);
        Assert.Equal("target/database/sales/object/20", Assert.Single(second.Objects).ObjectId);
        Assert.Equal(started, first.Evidence.ObservedAt);
        Assert.Equal(started.AddMinutes(2), second.Evidence.ObservedAt);
        foreach (var page in new[] { first, second })
        {
            Assert.Equal(2, page.TopQueryFamilies.Count);
            Assert.All(page.TopQueryFamilies, family =>
            {
                var recent = family.RecentActivity!;
                Assert.Equal(started, recent.WindowEnd);
                Assert.Equal(started.AddMinutes(-15), recent.WindowStart);
                Assert.True(recent.Covered);
                var (wait, category) = family.FamilyId == "Customer" ? ("11", "CPU") : ("22", "Lock");
                Assert.Equal(wait, recent.TotalWaitMilliseconds);
                Assert.Equal(wait, recent.WaitMillisecondsByCategory![category]);
            });
        }
        Assert.Equal("11", Assert.Single(first.TopQueryFamilies
            .Single(family => family.FamilyId == "Customer").RecentActivity!.WaitAttribution!.Objects).WaitMilliseconds);
        Assert.Equal("22", Assert.Single(second.TopQueryFamilies
            .Single(family => family.FamilyId == "OrderHeader").RecentActivity!.WaitAttribution!.Objects).WaitMilliseconds);

        var fresh = (await Source().GetDatabaseAsync(
            FakeQueryStore.DatabaseId, DatabaseCityMetric.Cpu, 1, null, default))!;
        Assert.All(fresh.TopQueryFamilies, family =>
        {
            var recent = family.RecentActivity!;
            Assert.Equal(started.AddMinutes(4), recent.WindowEnd);
            Assert.Equal(started.AddMinutes(-11), recent.WindowStart);
            Assert.False(recent.Covered);
            Assert.Equal("0", recent.TotalWaitMilliseconds);
            Assert.Null(recent.WaitAttribution);
        });
        Assert.Equal(0, attributionClock.Reads);
    }

    [Theory]
    [InlineData("1|target/database/sales|Cpu|1|10|1")]
    [InlineData("2|target/database/sales|Cpu|1|10|1|not-a-time")]
    [InlineData("2|target/database/sales|Cpu|1|10|1|0001-01-01T00:00:00.0000000+00:00")]
    public async Task RejectsLegacyOrInvalidWindowCursorsBeforeCollecting(string cursor)
    {
        var clock = new AdvancingClock(
            new DateTimeOffset(2026, 8, 17, 17, 0, 0, TimeSpan.Zero), TimeSpan.FromMilliseconds(1));
        var source = new ConnectedDatabaseCitySource(new FakeAtlasSource(), new PagingCityProbeExecutor(clock));
        var token = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(cursor))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

        await Assert.ThrowsAsync<DatabaseCityPageTokenException>(() => source.GetDatabaseAsync(
            FakeQueryStore.DatabaseId, DatabaseCityMetric.Cpu, 1, token, default));
        Assert.Equal(0, clock.Reads);
    }

    [Fact]
    public async Task QueryStoreFamiliesRoutesAndExposureReachTheConnectedPage()
    {
        var queryStore = new FakeQueryStore();
        queryStore.AddFamily("family-1", cpu: "900", executions: "30", plans:
            [FakeQueryStore.Plan("plan-1", FakeQueryStore.Reference(table: "Customer"))]);
        queryStore.AddFamily("family-2", cpu: "400", executions: "12", plans:
        [
            FakeQueryStore.Plan(
                "plan-2",
                FakeQueryStore.Reference(table: "Customer"),
                FakeQueryStore.Reference(table: "OrderHeader")),
        ]);

        var source = new ConnectedDatabaseCitySource(
            new FakeAtlasSource(),
            new FakeCityProbeExecutor(expectedTopN: 3),
            new QueryStoreCityAttribution(queryStore));

        var page = await source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);

        Assert.NotNull(page);
        Assert.Equal(["family-1", "family-2"], page!.TopQueryFamilies.Select(family => family.FamilyId));
        Assert.Equal("900", page.TopQueryFamilies[0].TotalCpuMicroseconds);

        var route = Assert.Single(page.Routes);
        Assert.Equal("target/database/sales/object/10", route.FromObjectId);
        Assert.Equal("target/database/sales/object/20", route.ToId);

        // family-1 named only the Customer table, so its totals attach to that building;
        // family-2 named two objects and is deliberately left at query level.
        var customer = page.Objects.Single(item => item.ObjectId == "target/database/sales/object/10");
        Assert.Equal("900", customer.AttributedExposure.TotalCpuMicroseconds);
        Assert.Equal(QueryAttributionConfidence.Confirmed, customer.AttributedExposure.Confidence);
        var orderHeader = page.Objects.Single(item => item.ObjectId == "target/database/sales/object/20");
        Assert.Null(orderHeader.AttributedExposure.TotalCpuMicroseconds);
        Assert.Equal(QueryAttributionConfidence.Unknown, orderHeader.AttributedExposure.Confidence);
        Assert.Contains(
            "not measured zero", orderHeader.AttributedExposure.Rationale, StringComparison.Ordinal);

        // family-2 named OrderHeader alongside Customer, so the page reports what that query
        // measured instead of leaving the building looking as though nothing ever touched it.
        Assert.Equal("400", orderHeader.AttributedExposure.Shared!.TotalCpuMicroseconds);
        Assert.Equal("400", customer.AttributedExposure.Shared!.TotalCpuMicroseconds);
    }

    /// <summary>
    /// Query Store history is collected per database name, while the city page is addressed by the
    /// atlas contract id. Filtering the join by the atlas id matches no published Query Store index,
    /// which silently reports every object on the page as having no attributed exposure.
    /// </summary>
    [Fact]
    public async Task QueryStoreIsFilteredByDatabaseNameNotTheAtlasDatabaseId()
    {
        var queryStore = new FakeQueryStore();
        queryStore.AddFamily("family-1", cpu: "900", executions: "30", plans:
            [FakeQueryStore.Plan("plan-1", FakeQueryStore.Reference(table: "Customer"))]);

        var source = new ConnectedDatabaseCitySource(
            new FakeAtlasSource(),
            new FakeCityProbeExecutor(expectedTopN: 3),
            new QueryStoreCityAttribution(queryStore));

        var page = await source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);

        Assert.Equal("sales", queryStore.RequestedDatabaseId);
        Assert.Equal(
            "900",
            page!.Objects.Single(item => item.ObjectId == "target/database/sales/object/10")
                .AttributedExposure.TotalCpuMicroseconds);
    }

    /// <summary>
    /// The published family count is the join key a live execution is matched against, so a page
    /// that publishes too few of them leaves the live feed inert and the map empty however much
    /// traffic the instance is serving. Measured against a seeded database holding 237 captured
    /// families, publishing twelve matched none of the eight executions sampled. The default is
    /// therefore well above twelve, and this pins that it is the source's own default that reaches
    /// Query Store rather than some incidental page size.
    /// </summary>
    [Fact]
    public async Task PublishesTheDefaultFamilyCountRatherThanThePageSize()
    {
        var queryStore = new FakeQueryStore();
        var source = new ConnectedDatabaseCitySource(
            new FakeAtlasSource(),
            new FakeCityProbeExecutor(expectedTopN: 3),
            new QueryStoreCityAttribution(queryStore));

        await source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);

        Assert.Equal(QueryStoreCityAttribution.DefaultTopFamilyCount, queryStore.RequestedPageSize);
        Assert.True(
            QueryStoreCityAttribution.DefaultTopFamilyCount >= 24,
            "A dozen families is too few to match live traffic against.");
    }

    /// <summary>
    /// An operator watching a small database may reasonably want every family it has. Attribution
    /// treats a count above its supported ceiling as a programming error and throws, which reaches
    /// the endpoint as a bare 500 that names neither the setting nor the limit -- so configuration
    /// is clamped to the ceiling instead of being passed through.
    /// </summary>
    [Fact]
    public async Task ClampsAConfiguredFamilyCountAboveTheCeilingInsteadOfFailingThePage()
    {
        var queryStore = new FakeQueryStore();
        var source = new ConnectedDatabaseCitySource(
            new FakeAtlasSource(),
            new FakeCityProbeExecutor(expectedTopN: 3),
            new QueryStoreCityAttribution(queryStore),
            topQueryFamilyCount: QueryStoreCityAttribution.MaxTopFamilyCount + 5_000);

        var page = await source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);

        Assert.NotNull(page);
        Assert.Equal(QueryStoreCityAttribution.MaxTopFamilyCount, queryStore.RequestedPageSize);
    }

    /// <summary>
    /// Zero is never "publish no families": a page with no families is indistinguishable from a
    /// database whose Query Store never captured anything, so a nonsense setting falls back to the
    /// default rather than quietly emptying the city.
    /// </summary>
    [Fact]
    public async Task FallsBackToTheDefaultWhenTheConfiguredFamilyCountIsNotPositive()
    {
        var queryStore = new FakeQueryStore();
        var source = new ConnectedDatabaseCitySource(
            new FakeAtlasSource(),
            new FakeCityProbeExecutor(expectedTopN: 3),
            new QueryStoreCityAttribution(queryStore),
            topQueryFamilyCount: 0);

        await source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);

        Assert.Equal(QueryStoreCityAttribution.DefaultTopFamilyCount, queryStore.RequestedPageSize);
    }

    /// <summary>
    /// A count the operator actually chose, and which the ceiling permits, must reach Query Store
    /// unchanged -- otherwise the setting silently does nothing.
    /// </summary>
    [Fact]
    public async Task PassesAConfiguredFamilyCountWithinTheCeilingThrough()
    {
        var queryStore = new FakeQueryStore();
        var source = new ConnectedDatabaseCitySource(
            new FakeAtlasSource(),
            new FakeCityProbeExecutor(expectedTopN: 3),
            new QueryStoreCityAttribution(queryStore),
            topQueryFamilyCount: 96);

        await source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);

        Assert.Equal(96, queryStore.RequestedPageSize);
    }

    private sealed class AdvancingClock(DateTimeOffset start, TimeSpan step) : TimeProvider
    {
        public int Reads { get; private set; }
        public override DateTimeOffset GetUtcNow() => start + step * Reads++;
    }

    private sealed class PagingCityProbeExecutor(TimeProvider clock) : IDatabaseCityProbeExecutor
    {
        public Task<DatabaseCityProbePage> CollectPageAsync(
            string databaseName, int afterObjectId, int topN, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Assert.Equal(FakeQueryStore.DatabaseName, databaseName);
            DatabaseCityInventoryRow[] rows =
            [
                new(10, 1001, 2, "dbo", "Customer", DatabaseObjectKind.Table,
                    "10", "5", 1, "PK_Customer", DatabaseIndexKind.Clustered),
                new(20, 1001, 2, "dbo", "OrderHeader", DatabaseObjectKind.Table,
                    "20", "10", 1, "PK_OrderHeader", DatabaseIndexKind.Clustered),
            ];
            return Task.FromResult(new DatabaseCityProbePage(
                rows.Where(row => row.ObjectId > afterObjectId).Take(topN).ToArray(), [],
                DataStatus.Available, "Captured.", clock.GetUtcNow(), TotalObjects: "2"));
        }
    }

    private sealed class FakeCityProbeExecutor(int expectedTopN = 2) : IDatabaseCityProbeExecutor
    {
        public Task<DatabaseCityProbePage> CollectPageAsync(
            string databaseName,
            int afterObjectId,
            int topN,
            CancellationToken cancellationToken)
        {
            Assert.Equal("sales", databaseName);
            Assert.Equal(0, afterObjectId);
            Assert.Equal(expectedTopN, topN);
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(new DatabaseCityProbePage(
                [
                    new DatabaseCityInventoryRow(
                        10, 1001, 2, "dbo", "Customer", DatabaseObjectKind.Table,
                        "10", "5", 1, "PK_Customer", DatabaseIndexKind.Clustered),
                    new DatabaseCityInventoryRow(
                        20, 1001, 2, "dbo", "OrderHeader", DatabaseObjectKind.Table,
                        "20", "10", 1, "PK_OrderHeader", DatabaseIndexKind.Clustered),
                ],
                [new DatabaseCityIndexUsageRow(10, 1, "5")],
                DataStatus.Available,
                "Direct cumulative index usage counters.",
                new DateTimeOffset(2026, 8, 17, 17, 0, 0, TimeSpan.Zero),
                TotalObjects: "7"));
        }
    }

    private sealed class IndexlessCityProbeExecutor : IDatabaseCityProbeExecutor
    {
        public Task<DatabaseCityProbePage> CollectPageAsync(
            string databaseName,
            int afterObjectId,
            int topN,
            CancellationToken cancellationToken) =>
            Task.FromResult(new DatabaseCityProbePage(
                [
                    new DatabaseCityInventoryRow(
                        10, 1001, 2, "dbo", "ExternalCustomer", DatabaseObjectKind.Table,
                        null, null, null, null, null),
                    new DatabaseCityInventoryRow(
                        20, 1001, 2, "dbo", "OrderHeader", DatabaseObjectKind.Table,
                        "20", "10", 1, "PK_OrderHeader", DatabaseIndexKind.Clustered),
                ],
                [],
                DataStatus.Available,
                "Direct cumulative index usage counters.",
                new DateTimeOffset(2026, 8, 17, 17, 0, 0, TimeSpan.Zero)));
    }

    private sealed class FailingCityProbeExecutor : IDatabaseCityProbeExecutor
    {
        public Task<DatabaseCityProbePage> CollectPageAsync(
            string databaseName,
            int afterObjectId,
            int topN,
            CancellationToken cancellationToken) =>
            throw new ProbePermissionDeniedException(
                "The reader lacks VIEW DATABASE STATE.", null, null);
    }

    private sealed class FakeAtlasSource : IAtlasSnapshotSource
    {
        public AtlasSnapshotV1 GetCurrent()
        {
            var now = new DateTimeOffset(2026, 8, 17, 17, 0, 0, TimeSpan.Zero);
            var evidence = new EvidenceV1(
                EvidenceSource.CatalogSnapshot, DataStatus.Available, now, null, "Fixture.");
            var allocated = new ByteMeasurementV1("163840", MeasurementStatus.Known, null, evidence);
            var used = new ByteMeasurementV1("81920", MeasurementStatus.Known, null, evidence);
            var queryStore = new QueryStoreHistoryV1(
                null, null, null, null, null, QueryStoreCapability.Unknown,
                QueryStoreHealth.Unknown, "Not collected.", evidence);
            var database = new DatabaseAtlasItemV1(
                "target/database/sales", "sales", allocated, used,
                new LiveActivityV1(null, null, null, null, evidence), queryStore)
            {
                FileIo = new FileIoV1(
                    null, null, null, null, null, "epoch:1", evidence),
            };
            return new AtlasSnapshotV1(
                "1.0", "snapshot:1", new AtlasTargetV1("target", "Target", "SQL Server"),
                now, [database], []);
        }
    }
}
