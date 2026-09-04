using System.Collections.ObjectModel;
using System.Xml;
using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.Tests.DatabaseCity;

/// <summary>
/// Covers the join that turns Query Store families into city evidence. The rules under test are
/// all forms of one promise: the join reports what the plans actually named, and says so plainly
/// when it could not resolve something, rather than inventing an attribution.
/// </summary>
public sealed class QueryStoreCityAttributionTests
{
    private const string DatabaseId = FakeQueryStore.DatabaseId;
    private const string CustomerId = "target/database/sales/object/10";
    private const string OrderId = "target/database/sales/object/20";

    private static readonly IReadOnlyList<CityAttributionObject> PageObjects =
    [
        new(CustomerId, "dbo", "Customer", DatabaseObjectKind.Table),
        new(OrderId, "dbo", "OrderHeader", DatabaseObjectKind.Table),
    ];

    private static Task<CityAttributionResult> AttributeAsync(
        FakeQueryStore store,
        IReadOnlyList<CityAttributionObject>? pageObjects = null,
        IReadOnlyDictionary<string, string>? databaseIdsByName = null) =>
        new QueryStoreCityAttribution(store).AttributeAsync(
            FakeQueryStore.DatabaseName,
            DatabaseCityMetric.Cpu,
            pageObjects ?? PageObjects,
            databaseIdsByName ?? new Dictionary<string, string> { ["sales"] = DatabaseId },
            topFamilyCount: 12,
            CancellationToken.None);

    [Fact]
    public async Task PublishedDatabaseNamespaceUsesExactFamilyIdentityRatherThanCatalogAlias()
    {
        var store = new FakeQueryStore { ExpectedDatabaseName = "Sales" };
        store.AddFamily("first", "1", "1", [Plan("first-plan", Reference(table: "Customer"))],
            databaseId: "sAlEs");
        store.AddFamily("second", "1", "1", [Plan("second-plan", Reference(table: "OrderHeader"))],
            databaseId: "sAlEs");

        var result = await new QueryStoreCityAttribution(store).AttributeAsync(
            "Sales", DatabaseCityMetric.Cpu, PageObjects, new Dictionary<string, string>(), 12, default);

        Assert.Equal(2, result.Families.Count);
        Assert.Equal("sAlEs", result.QueryStoreDatabaseId);
        Assert.Equal("Sales", store.RequestedDatabaseId);
    }

    [Theory]
    [InlineData("Sales")]
    [InlineData("inventory")]
    public async Task PublishedDatabaseNamespaceIsUnknownWhenFamilyIdentitiesDisagree(string secondDatabaseId)
    {
        var store = new FakeQueryStore();
        store.AddFamily("first", "1", "1", [Plan("first-plan", Reference(table: "Customer"))],
            databaseId: "sales");
        store.AddFamily("second", "1", "1", [Plan("second-plan", Reference(table: "OrderHeader"))],
            databaseId: secondDatabaseId);

        var result = await AttributeAsync(store);

        Assert.Equal(2, result.Families.Count);
        Assert.Null(result.QueryStoreDatabaseId);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("inventory")]
    public async Task PublishedDatabaseNamespaceCannotAttestBlankOrUnrelatedFamilyIdentities(string databaseId)
    {
        var store = new FakeQueryStore();
        store.AddFamily("first", "1", "1", [Plan("plan", Reference(table: "Customer"))],
            databaseId: databaseId);

        var result = await AttributeAsync(store);

        Assert.Single(result.Families);
        Assert.Null(result.QueryStoreDatabaseId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PublishedDatabaseNamespaceIsUnknownWithoutReadableFamilySummaries(bool failed)
    {
        var result = await AttributeAsync(new FakeQueryStore { ThrowOnQueries = failed });

        Assert.Empty(result.Families);
        Assert.Null(result.QueryStoreDatabaseId);
    }

    [Fact]
    public async Task SingleObjectPlanIsConfirmedAndCarriesTheFamilyTotalsUndivided()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "900", executions: "30", plans:
            [Plan("plan-1", Reference(table: "Customer"))]);

        var result = await AttributeAsync(store);

        var family = Assert.Single(result.Families);
        Assert.Equal("family-1", family.FamilyId);
        Assert.Equal(CustomerId, Assert.Single(family.ObjectIds));
        Assert.Equal(QueryAttributionConfidence.Confirmed, family.Confidence);
        Assert.Equal("900", family.TotalCpuMicroseconds);

        var exposure = result.ExposureByObjectId[CustomerId];
        Assert.Equal("900", exposure.TotalCpuMicroseconds);
        Assert.Equal("30", exposure.ExecutionCount);
        Assert.Equal(QueryAttributionConfidence.Confirmed, exposure.Confidence);
    }

    /// <summary>
    /// The reported workload's real shape: a normalized schema where ranked queries join several
    /// tables. Sole attribution and shared exposure have to coexist on one building without the
    /// shared figures being folded into the measured total.
    /// </summary>
    [Fact]
    public async Task SoleAndSharedExposureCoexistWithoutTheSharedTotalsBeingAddedIn()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-sole", cpu: "900", executions: "30", plans:
            [Plan("plan-1", Reference(table: "Customer"))]);
        store.AddFamily("family-join", cpu: "5000", executions: "40", plans:
            [Plan("plan-2", Reference(table: "Customer"), Reference(table: "OrderHeader"))]);

        var result = await AttributeAsync(store);

        var customer = result.ExposureByObjectId[CustomerId];
        Assert.Equal("900", customer.TotalCpuMicroseconds);
        Assert.Equal("5000", customer.Shared!.TotalCpuMicroseconds);
        Assert.Equal("1", customer.Shared.FamilyCount);
        Assert.Contains("are not added here", customer.Rationale, StringComparison.Ordinal);

        // The joined partner has no total of its own but is not blank either.
        var orderHeader = result.ExposureByObjectId[OrderId];
        Assert.Null(orderHeader.TotalCpuMicroseconds);
        Assert.Equal("5000", orderHeader.Shared!.TotalCpuMicroseconds);

        // 5000 appears on both buildings because one query touched both. Summing the city would
        // report 10000 microseconds of CPU that was never spent.
        Assert.Equal(customer.Shared.TotalCpuMicroseconds, orderHeader.Shared.TotalCpuMicroseconds);
    }

    [Fact]
    public async Task MultiObjectPlanStaysProbableAndIsNeverSplitAcrossItsObjects()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "1000", executions: "10", plans:
            [Plan("plan-1", Reference(table: "Customer"), Reference(table: "OrderHeader"))]);

        var result = await AttributeAsync(store);

        var family = Assert.Single(result.Families);
        Assert.Equal([CustomerId, OrderId], family.ObjectIds);
        Assert.Equal(QueryAttributionConfidence.Probable, family.Confidence);
        Assert.Equal("1000", family.TotalCpuMicroseconds);

        // Neither building may claim a share of a total the plan never attributed to it, so the
        // scalar stays unavailable on both. The query's own figure is still reported on each, whole
        // and explicitly non-additive, so a join-heavy workload is not silently blank.
        foreach (var objectId in new[] { CustomerId, OrderId })
        {
            var exposure = result.ExposureByObjectId[objectId];
            Assert.Null(exposure.TotalCpuMicroseconds);
            Assert.Equal(QueryAttributionConfidence.Unknown, exposure.Confidence);
            Assert.Equal("1000", exposure.Shared!.TotalCpuMicroseconds);
            Assert.Equal("1", exposure.Shared.FamilyCount);
            Assert.Contains(
                "must not be summed across buildings",
                exposure.Shared.Rationale,
                StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task IndexedViewStaysProbableBecauseTheOptimizerCanExpandIt()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "500", executions: "5", plans:
            [Plan("plan-1", Reference(table: "CustomerSummary"))]);

        var result = await AttributeAsync(store, pageObjects:
        [
            new("target/database/sales/object/30", "dbo", "CustomerSummary", DatabaseObjectKind.IndexedView),
        ]);

        var family = Assert.Single(result.Families);
        Assert.Equal(QueryAttributionConfidence.Probable, family.Confidence);
        Assert.Contains("indexed view", family.Rationale, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ReferenceToAnObjectOutsideThePageIsDisclosedRatherThanDropped()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "700", executions: "7", plans:
            [Plan("plan-1", Reference(table: "Invoice"))]);

        var result = await AttributeAsync(store);

        var family = Assert.Single(result.Families);
        Assert.Empty(family.ObjectIds);
        Assert.Equal(QueryAttributionConfidence.Unknown, family.Confidence);
        Assert.Contains("dbo.Invoice", family.Rationale, StringComparison.Ordinal);
        Assert.Empty(result.ExposureByObjectId);
    }

    [Fact]
    public async Task CoReferencedObjectsInOnePlanBecomeAConfirmedRoute()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(table: "Customer"), Reference(table: "OrderHeader"))]);

        var result = await AttributeAsync(store);

        var route = Assert.Single(result.Routes);
        Assert.Equal(CustomerId, route.FromObjectId);
        Assert.Equal(OrderId, route.ToId);
        Assert.Equal(DatabaseCityRouteKind.ObjectReference, route.Kind);
        Assert.Equal(EdgeConfidence.Confirmed, route.Confidence);
    }

    [Fact]
    public async Task ReferenceToAnotherDatabaseBecomesAProbableCrossDatabaseRoute()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(table: "Customer"), Reference(database: "warehouse", table: "FactSale"))]);

        var result = await AttributeAsync(store, databaseIdsByName: new Dictionary<string, string>
        {
            ["sales"] = DatabaseId,
            ["warehouse"] = "target/database/warehouse",
        });

        var route = Assert.Single(result.Routes);
        Assert.Equal(CustomerId, route.FromObjectId);
        Assert.Equal("target/database/warehouse", route.ToId);
        Assert.Equal(DatabaseCityRouteKind.CrossDatabaseReference, route.Kind);
        Assert.Equal(EdgeConfidence.Probable, route.Confidence);

        // The local object is still only one local reference, but the cross-database hop means the
        // family's cost cannot be claimed entirely by this database's building.
        Assert.Equal(QueryAttributionConfidence.Probable, Assert.Single(result.Families).Confidence);
    }

    [Fact]
    public async Task ReferenceToAnUnknownDatabaseIsNotGuessedIntoARoute()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(table: "Customer"), Reference(database: "elsewhere", table: "FactSale"))]);

        var result = await AttributeAsync(store);

        Assert.Empty(result.Routes);
        var family = Assert.Single(result.Families);
        Assert.Contains("elsewhere.dbo.FactSale", family.Rationale, StringComparison.Ordinal);
        Assert.Equal(QueryAttributionConfidence.Probable, family.Confidence);
        Assert.Null(result.ExposureByObjectId[CustomerId].TotalCpuMicroseconds);
    }

    /// <summary>
    /// The predicate that decides exposure and the sentence that explains the family must be the
    /// same predicate. A family naming one on-page object plus one off-page object used to claim it
    /// "names exactly one local object" while being refused as that object's attribution, so a
    /// single response contradicted itself.
    /// </summary>
    [Fact]
    public async Task AFamilyNeverClaimsToNameOneObjectWhileBeingRefusedAsItsAttribution()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "800", executions: "8", plans:
            [Plan("plan-1", Reference(table: "Customer"), Reference(table: "Invoice"))]);

        var result = await AttributeAsync(store);

        var family = Assert.Single(result.Families);
        Assert.DoesNotContain("exactly one local object", family.Rationale, StringComparison.Ordinal);
        Assert.Contains("one object on this page", family.Rationale, StringComparison.Ordinal);
        Assert.Contains("remain query-level", family.Rationale, StringComparison.Ordinal);
        Assert.Null(result.ExposureByObjectId[CustomerId].TotalCpuMicroseconds);
    }

    [Fact]
    public async Task AnOnPageObjectDoesNotAbsorbTotalsFromAPlanThatAlsoNamedAnOffPageObject()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "800", executions: "8", plans:
            [Plan("plan-1", Reference(table: "Customer"), Reference(table: "Invoice"))]);

        var result = await AttributeAsync(store);

        var family = Assert.Single(result.Families);
        Assert.Equal(CustomerId, Assert.Single(family.ObjectIds));
        Assert.Equal(QueryAttributionConfidence.Probable, family.Confidence);
        Assert.Contains("dbo.Invoice", family.Rationale, StringComparison.Ordinal);

        // The plan touched something this page cannot show, so the Customer building must not be
        // credited with the whole family as its own measured total.
        var exposure = result.ExposureByObjectId[CustomerId];
        Assert.Null(exposure.TotalCpuMicroseconds);
        Assert.Null(exposure.ExecutionCount);
        Assert.Equal(QueryAttributionConfidence.Unknown, exposure.Confidence);

        // It is still shared exposure: the family did name this object, and saying nothing at all
        // would be indistinguishable from never having measured it.
        Assert.Equal("800", exposure.Shared!.TotalCpuMicroseconds);
        Assert.Equal("8", exposure.Shared.ExecutionCount);
    }

    /// <summary>
    /// An object no ranked family named anywhere is left out of the join entirely, so the page can
    /// tell "nothing named it" apart from "something named it alongside others".
    /// </summary>
    [Fact]
    public async Task AnObjectNoFamilyNamedIsAbsentRatherThanReportedAsSharedZero()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "900", executions: "30", plans:
            [Plan("plan-1", Reference(table: "Customer"))]);

        var result = await AttributeAsync(store);

        Assert.True(result.ExposureByObjectId.ContainsKey(CustomerId));
        Assert.False(result.ExposureByObjectId.ContainsKey(OrderId));
        Assert.Null(result.ExposureByObjectId[CustomerId].Shared);
    }

    [Fact]
    public async Task WaitCategoriesArePublishedOnlyWhenTheyReconcileWithTheFamilyTotal()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "2", waitMilliseconds: "30", plans:
            [Plan("plan-1", Reference(table: "Customer"))], runtimeWaits:
            [
                new Dictionary<string, string> { ["CPU"] = "10", ["Buffer IO"] = "5" },
                new Dictionary<string, string> { ["CPU"] = "15" },
            ]);

        var family = Assert.Single((await AttributeAsync(store)).Families);

        Assert.Equal("30", family.TotalWaitMilliseconds);
        Assert.Equal("25", family.WaitMillisecondsByCategory["CPU"]);
        Assert.Equal("5", family.WaitMillisecondsByCategory["Buffer IO"]);
    }

    [Fact]
    public async Task WaitCategoriesAreWithheldWhenTheyDoNotReconcile()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "2", waitMilliseconds: "30", plans:
            [Plan("plan-1", Reference(table: "Customer"))], runtimeWaits:
            [new Dictionary<string, string> { ["CPU"] = "10" }]);

        var family = Assert.Single((await AttributeAsync(store)).Families);

        // Reporting 10 ms of CPU wait against a 30 ms total would imply the other 20 ms were
        // uncategorised, which the buckets do not say. Publish nothing instead.
        Assert.Equal("30", family.TotalWaitMilliseconds);
        Assert.Empty(family.WaitMillisecondsByCategory);
    }

    [Fact]
    public async Task OtherWorkloadCountsTheRemainingFamiliesAndLeavesUnaggregatedTotalsNull()
    {
        var store = new FakeQueryStore { TotalCount = "57" };
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(table: "Customer"))]);
        store.AddFamily("family-2", cpu: "50", executions: "1", plans:
            [Plan("plan-2", Reference(table: "OrderHeader"))]);

        var result = await AttributeAsync(store);

        Assert.Equal("55", result.OtherWorkload.FamilyCount);
        Assert.Null(result.OtherWorkload.TotalCpuMicroseconds);
        Assert.Null(result.OtherWorkload.ExecutionCount);
        Assert.Contains("never zero", result.OtherWorkload.Evidence.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task OtherWorkloadFamilyCountIsUnknownWhenQueryStoreDidNotPublishATotal()
    {
        var store = new FakeQueryStore { TotalCount = null };
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(table: "Customer"))]);

        var result = await AttributeAsync(store);

        Assert.Null(result.OtherWorkload.FamilyCount);
    }

    [Fact]
    public async Task PlansBeyondThePerFamilyBudgetAreDisclosedAsSkipped()
    {
        var plans = Enumerable
            .Range(0, QueryStoreCityAttribution.MaxPlansPerFamily + 3)
            .Select(i => Plan($"plan-{i}", Reference(table: "Customer")))
            .ToArray();
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "1", plans: plans);

        var family = Assert.Single((await AttributeAsync(store)).Families);

        Assert.Equal(QueryStoreCityAttribution.MaxPlansPerFamily, store.PlansRequested);
        Assert.Contains("incomplete", family.Rationale, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AQueryStoreFailureLeavesThePageHonestlyUnattributedInsteadOfFailing()
    {
        var result = await AttributeAsync(new FakeQueryStore { ThrowOnQueries = true });

        Assert.Empty(result.Families);
        Assert.Empty(result.Routes);
        Assert.Empty(result.ExposureByObjectId);
        Assert.Equal(DataStatus.Unknown, result.Evidence.Status);
    }

    [Fact]
    public async Task AMissingPlanReducesConfidenceRatherThanBeingTreatedAsNoReferences()
    {
        var store = new FakeQueryStore { ReturnNullPlans = true };
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(table: "Customer"))]);

        var family = Assert.Single((await AttributeAsync(store)).Families);

        Assert.Empty(family.ObjectIds);
        Assert.Equal(QueryAttributionConfidence.Unknown, family.Confidence);
    }

    [Fact]
    public async Task FailedPlanAttemptsStillConsumeBothHydrationBudgets()
    {
        var store = new FakeQueryStore
        {
            ReadPlanOverride = (_, _) => throw new XmlException("malformed"),
        };
        for (var family = 0; family < 30; family++)
            store.AddFamily($"family-{family}", "1", "1",
                Enumerable.Range(0, 12).Select(plan => Plan($"{family}:{plan}", Reference(table: "Customer"))).ToArray());

        var result = await new QueryStoreCityAttribution(store).AttributeAsync(
            FakeQueryStore.DatabaseName, DatabaseCityMetric.Cpu, PageObjects,
            new Dictionary<string, string>(), 250, default);

        Assert.Equal(QueryStoreCityAttribution.MaxPlansPerPage, store.PlansRequested);
        Assert.Equal(30, result.Families.Count);
        Assert.All(result.Families, family => Assert.Empty(family.ObjectIds));
        Assert.Contains("4 further", result.Families[0].Rationale, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MalformedOrOversizedPlanDoesNotEraseReadableGeometryOrClaimItsWaits(bool oversized)
    {
        var parser = new SecureShowplanParser(new ShowplanParserLimits(MaximumXmlCharacters: 500));
        var bad = oversized ? $"<ShowPlanXML>{new string('x', 501)}</ShowPlanXML>" : "<broken>";
        const string good = """
            <ShowPlanXML><RelOp NodeId="0" LogicalOp="Scan" PhysicalOp="Index Scan" EstimateCPU="1">
            <Object Schema="dbo" Table="Customer"/></RelOp></ShowPlanXML>
            """;
        var store = new FakeQueryStore
        {
            ReadPlanOverride = async (id, token) => await parser.ParseAsync(id, id == "bad" ? bad : good, token),
        };
        store.AddFamily("mixed", "100", "2",
            [Plan("bad"), Plan("good")], waitMilliseconds: "19");
        store.AddFamily("healthy", "20", "1", [Plan("healthy")]);

        var result = await AttributeAsync(store);

        var mixed = result.Families.Single(family => family.FamilyId == "mixed");
        Assert.Equal(CustomerId, Assert.Single(mixed.ObjectIds));
        Assert.Equal(QueryAttributionConfidence.Probable, mixed.Confidence);
        Assert.Equal("19", mixed.WaitAttribution!.UnattributedWaitMilliseconds);
        Assert.Empty(mixed.WaitAttribution.Objects);
        Assert.Contains("failed bounded XML normalization", mixed.Rationale, StringComparison.Ordinal);
        Assert.Equal("20", result.ExposureByObjectId[CustomerId].TotalCpuMicroseconds);
        Assert.Equal("100", result.ExposureByObjectId[CustomerId].Shared!.TotalCpuMicroseconds);
        // The parser and direct-plan error boundary are intentionally not weakened.
        await Assert.ThrowsAsync<XmlException>(() => parser.ParseAsync("bad", bad));
    }

    [Fact]
    public async Task UnexpectedPlanExceptionsAreNotSwallowed()
    {
        var store = new FakeQueryStore { ReadPlanOverride = (_, _) => throw new InvalidOperationException("bug") };
        store.AddFamily("family", "1", "1", [Plan("bad")]);
        await Assert.ThrowsAsync<InvalidOperationException>(() => AttributeAsync(store));
    }

    [Fact]
    public async Task BracketQuotedAndDifferentlyCasedReferencesMatchTheSameBuilding()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(schema: "[DBO]", table: "[customer]"))]);

        var family = Assert.Single((await AttributeAsync(store)).Families);

        Assert.Equal(CustomerId, Assert.Single(family.ObjectIds));
    }

    [Fact]
    public async Task AnUnqualifiedReferenceIsNotResolvedWhenTwoSchemasShareTheName()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "100", executions: "1", plans:
            [Plan("plan-1", Reference(schema: null, table: "Customer"))]);

        var result = await AttributeAsync(store, pageObjects:
        [
            new(CustomerId, "dbo", "Customer", DatabaseObjectKind.Table),
            new(OrderId, "sales", "Customer", DatabaseObjectKind.Table),
        ]);

        Assert.Empty(Assert.Single(result.Families).ObjectIds);
    }

    private static ShowplanObjectV1 Reference(
        string? database = null,
        string? schema = "dbo",
        string? table = null,
        string? index = null) => FakeQueryStore.Reference(database, schema, table, index);

    private static (string PlanId, FakeQueryStore.PlanNode[] Nodes) Plan(
        string planId,
        params ShowplanObjectV1[] references) => FakeQueryStore.Plan(planId, references);
}

/// <summary>
/// The recent traffic window: what a family did in the last few minutes, which is what the map
/// grades street colour from. An average over the whole retained horizon answers a different
/// question, one where a finished batch job goes on colouring a street red for the rest of the day.
/// </summary>
public sealed class QueryStoreCityRecentActivityTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 17, 18, 0, 0, TimeSpan.Zero);
    private const string CustomerId = "target/database/sales/object/10";

    private static readonly IReadOnlyList<CityAttributionObject> PageObjects =
    [
        new(CustomerId, "dbo", "Customer", DatabaseObjectKind.Table),
    ];

    private static Task<CityAttributionResult> AttributeAsync(
        FakeQueryStore store, TimeSpan? window = null) =>
        new QueryStoreCityAttribution(
                store, window, new FixedClock(Now))
            .AttributeAsync(
                FakeQueryStore.DatabaseName,
                DatabaseCityMetric.Cpu,
                PageObjects,
                new Dictionary<string, string> { ["sales"] = FakeQueryStore.DatabaseId },
                topFamilyCount: 12,
                CancellationToken.None);

    private static void AddFamily(
        FakeQueryStore store,
        string familyId,
        params FakeQueryStore.RuntimeInterval[] intervals) =>
        store.AddFamily(
            familyId, cpu: "900", executions: "30",
            plans: [FakeQueryStore.Plan($"plan-{familyId}", FakeQueryStore.Reference(table: "Customer"))],
            runtimeIntervals: intervals);

    /// <summary>
    /// Query Store's current interval is still open: its end is in the future because it is still
    /// being written to. Selecting intervals that <em>ended</em> inside the window therefore drops
    /// the one bucket holding live traffic, and the busiest family on the instance reports as idle.
    /// </summary>
    [Fact]
    public async Task TheStillOpenCurrentIntervalCountsAsRecentActivity()
    {
        var store = new FakeQueryStore();
        AddFamily(store, "family-live", new FakeQueryStore.RuntimeInterval(
            Now.AddMinutes(-30), Now.AddMinutes(30), Executions: "42", WaitMilliseconds: "500"));

        var result = await AttributeAsync(store);

        var recent = Assert.Single(result.Families).RecentActivity;
        Assert.NotNull(recent);
        Assert.True(recent.Covered);
        Assert.Equal("42", recent.ExecutionCount);
        Assert.Equal("500", recent.TotalWaitMilliseconds);
    }

    [Fact]
    public async Task AnIntervalEntirelyBeforeTheWindowIsNotRecentActivity()
    {
        var store = new FakeQueryStore();
        AddFamily(store, "family-old", new FakeQueryStore.RuntimeInterval(
            Now.AddHours(-5), Now.AddHours(-4), Executions: "9999", WaitMilliseconds: "9999"));

        var result = await AttributeAsync(store);

        var recent = Assert.Single(result.Families).RecentActivity;
        Assert.NotNull(recent);
        Assert.False(recent.Covered);
        Assert.Equal("0", recent.ExecutionCount);
        Assert.Equal("0", recent.TotalWaitMilliseconds);
    }

    /// <summary>
    /// A family Query Store captured nothing recent for reports no coverage rather than zero
    /// traffic. The map colours the first grey and the second green, and folding them together is
    /// the easiest way to make the map claim a street is clear when nothing was ever measured on it.
    /// </summary>
    [Fact]
    public async Task NoOverlappingIntervalReportsMissingCoverageRatherThanAnIdleFamily()
    {
        var store = new FakeQueryStore();
        AddFamily(store, "family-uncaptured");

        var result = await AttributeAsync(store);

        var recent = Assert.Single(result.Families).RecentActivity;
        Assert.NotNull(recent);
        Assert.False(recent.Covered);
        Assert.Contains("not known", recent.Rationale, StringComparison.Ordinal);
        Assert.Contains("not an idle query", recent.Rationale, StringComparison.Ordinal);
    }

    /// <summary>
    /// The whole point of the change: a family whose retained totals are enormous but whose recent
    /// window is empty must not go on being graded from the totals. Both figures are published, and
    /// they disagree here on purpose.
    /// </summary>
    [Fact]
    public async Task RetainedTotalsAndTheRecentWindowAreReportedSeparately()
    {
        var store = new FakeQueryStore();
        AddFamily(store, "family-batch", new FakeQueryStore.RuntimeInterval(
            Now.AddHours(-8), Now.AddHours(-7), Executions: "500000", WaitMilliseconds: "800000"));

        var family = Assert.Single((await AttributeAsync(store)).Families);

        Assert.Equal("30", family.ExecutionCount);
        Assert.Equal("0", family.RecentActivity!.ExecutionCount);
        Assert.False(family.RecentActivity.Covered);
    }

    [Fact]
    public async Task TheWindowDefaultsToFifteenMinutesAndIsReportedWithTheCounts()
    {
        var store = new FakeQueryStore();
        AddFamily(store, "family-1", new FakeQueryStore.RuntimeInterval(
            Now.AddMinutes(-5), Now.AddMinutes(5)));

        var recent = Assert.Single((await AttributeAsync(store)).Families).RecentActivity;

        Assert.Equal(15, recent!.WindowMinutes);
        Assert.Equal(Now.AddMinutes(-15), recent.WindowStart);
        Assert.Equal(Now, recent.WindowEnd);
    }

    /// <summary>
    /// A wider window reaches an interval the default excludes, which is what an operator watching
    /// a quiet instance is configuring it for.
    /// </summary>
    [Fact]
    public async Task AWiderConfiguredWindowReachesAnIntervalTheDefaultExcludes()
    {
        var store = new FakeQueryStore();
        AddFamily(store, "family-1", new FakeQueryStore.RuntimeInterval(
            Now.AddMinutes(-50), Now.AddMinutes(-40), Executions: "7"));

        Assert.False(Assert.Single((await AttributeAsync(store)).Families).RecentActivity!.Covered);

        var wide = await AttributeAsync(store, TimeSpan.FromHours(1));

        var recent = Assert.Single(wide.Families).RecentActivity;
        Assert.True(recent!.Covered);
        Assert.Equal("7", recent.ExecutionCount);
        Assert.Equal(60, recent.WindowMinutes);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2 * 24 * 60)]
    public void AWindowOutsideTheSupportedRangeIsRejected(int minutes)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            new QueryStoreCityAttribution(new FakeQueryStore(), TimeSpan.FromMinutes(minutes)));
    }

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
    /// <summary>
    /// Query Store totals are <c>average × execution count</c>, and its averages are decimals, so a
    /// real total arrives as an integer with a float tail: <c>"8039297979.000000331"</c>. Parsing
    /// those integers-only published a flat zero -- measured against a live AdventureWorks, every
    /// family's window duration read <c>0</c> while the same family's retained total read 8.0e9.
    /// A fabricated zero is worse than an omission, because nothing about it says it is missing.
    /// </summary>
    [Fact]
    public async Task ADecimalDurationTotalIsCountedRatherThanReadAsZero()
    {
        var store = new FakeQueryStore();
        AddFamily(store, "family-decimal", new FakeQueryStore.RuntimeInterval(
            Now.AddMinutes(-5), Now.AddMinutes(55),
            Executions: "2", DurationMicroseconds: "8039297979.000000331"));

        var result = await AttributeAsync(store);

        var recent = result.Families.Single().RecentActivity;
        Assert.NotNull(recent);
        Assert.True(recent!.Covered);
        // Truncated, not rounded up, and certainly not zero: the tail is float noise below a microsecond.
        Assert.Equal("8039297979", recent.TotalDurationMicroseconds);
    }

    /// <summary>
    /// A counter that is not a number at all still contributes nothing rather than taking the page
    /// down, which is the behaviour the truncating parse must not have traded away.
    /// </summary>
    [Fact]
    public async Task AMalformedCounterContributesNothingRatherThanFailingThePage()
    {
        var store = new FakeQueryStore();
        AddFamily(store, "family-malformed", new FakeQueryStore.RuntimeInterval(
            Now.AddMinutes(-5), Now.AddMinutes(55), Executions: "2", DurationMicroseconds: "not-a-number"));

        var result = await AttributeAsync(store);

        var recent = result.Families.Single().RecentActivity;
        Assert.Equal("0", recent!.TotalDurationMicroseconds);
        Assert.Equal("2", recent.ExecutionCount);
    }
}