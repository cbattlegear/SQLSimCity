using System.Globalization;
using System.Numerics;
using System.Text.Json;
using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.DatabaseCity;

public sealed class QueryStoreCityRecentAttributionTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 4, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task EveryFamilyInAnAttributionPassUsesOneWindowDespiteAnAdvancingClock()
    {
        var store = new FakeQueryStore();
        store.AddFamily("first", "1", "1", [Plan("first-plan", "Customer")],
            runtimeIntervals: [Interval("first-plan", "10", Now.AddMinutes(-10))]);
        store.AddFamily("second", "1", "1", [Plan("second-plan", "Orders")],
            runtimeIntervals: [Interval("second-plan", "20", Now.AddMinutes(-10))]);
        var clock = new AdvancingClock();
        var result = await new QueryStoreCityAttribution(store, timeProvider: clock).AttributeAsync(
            FakeQueryStore.DatabaseName, DatabaseCityMetric.Cpu,
            [new("customer", "dbo", "Customer", DatabaseObjectKind.Table),
             new("orders", "dbo", "Orders", DatabaseObjectKind.Table)],
            new Dictionary<string, string>(), 12, default);

        Assert.Equal(2, result.Families.Count);
        Assert.All(result.Families, family =>
        {
            Assert.Equal(Now, family.RecentActivity!.WindowEnd);
            Assert.Equal(Now.AddMinutes(-15), family.RecentActivity.WindowStart);
        });
        Assert.Equal(1, clock.Reads);
    }

    [Fact]
    public async Task RecentAttributionUsesRecentPlanWaitsRatherThanRetainedPlanShares()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family", "1", "1", [Plan("old", "Customer"), Plan("current", "Orders")],
            waitMilliseconds: "9010", runtimeIntervals:
            [
                Interval("old", "9000", Now.AddHours(-4)),
                Interval("current", "10", Now.AddMinutes(-10), category: "Lock"),
            ]);

        var recent = await RecentAsync(store);

        Assert.Equal("10", recent.TotalWaitMilliseconds);
        Assert.Equal("10", recent.WaitMillisecondsByCategory!["Lock"]);
        Assert.DoesNotContain("CPU", recent.WaitMillisecondsByCategory.Keys);
        var placed = Assert.Single(recent.WaitAttribution!.Objects);
        Assert.Equal("orders", placed.ObjectId);
        Assert.Equal("10", placed.WaitMilliseconds);
        Assert.Equal(1m, placed.EstimatedCostShare);
        Assert.Equal("0", recent.WaitAttribution.UnattributedWaitMilliseconds);
    }

    [Theory]
    [InlineData("11", "33")]
    [InlineData("999999999999999999999999999999999999", "333333333333333333333333333333333333")]
    public async Task RecentPlanWaitsAndUnassignedRemainderReconcileExactly(string readable, string unavailable)
    {
        var store = new FakeQueryStore();
        store.UnavailablePlanIds.Add("missing");
        store.AddFamily("family", "1", "1",
            [Plan("readable", "Customer"), Plan("missing", "Orders"), Plan("offpage", "Elsewhere")],
            runtimeIntervals:
            [
                Interval("readable", readable, Now.AddMinutes(-10)),
                Interval("missing", unavailable, Now.AddMinutes(-10)),
                Interval("offpage", "7", Now.AddMinutes(-10)),
            ]);

        var recent = await RecentAsync(store);

        var attribution = recent.WaitAttribution!;
        Assert.Equal(readable, Assert.Single(attribution.Objects).WaitMilliseconds);
        Assert.Equal(Integer(unavailable) + 7, Integer(attribution.UnattributedWaitMilliseconds));
        Assert.Equal(Integer(recent.TotalWaitMilliseconds),
            attribution.Objects.Aggregate(Integer(attribution.UnattributedWaitMilliseconds),
                (sum, item) => sum + Integer(item.WaitMilliseconds)));
        Assert.Equal(recent.TotalWaitMilliseconds, recent.WaitMillisecondsByCategory!["CPU"]);
        Assert.Contains("never absorb", attribution.Rationale, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RecentZeroStaysMeasuredZeroWithoutRetainedHotWaits()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family", "1", "1", [Plan("plan", "Customer")], runtimeIntervals:
        [
            Interval("plan", "9999", Now.AddHours(-5)),
            Interval("plan", "0", Now.AddMinutes(-10)),
        ]);
        var recent = await RecentAsync(store);
        Assert.True(recent.Covered);
        Assert.Equal("0", recent.TotalWaitMilliseconds);
        Assert.Equal("0", recent.WaitMillisecondsByCategory!["CPU"]);
        Assert.Equal("0", Assert.Single(recent.WaitAttribution!.Objects).WaitMilliseconds);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MissingOrPartialRecentWaitCaptureDoesNotPublishACompleteWaitProjection(bool partial)
    {
        var store = new FakeQueryStore();
        store.AddFamily("family", "1", "1", [Plan("plan", "Customer")], runtimeIntervals:
        [
            Interval("plan", "0", Now.AddMinutes(-10)) with { WaitCategories = new Dictionary<string, string>() },
            Interval("plan", partial ? "5" : "0", Now.AddMinutes(-5)),
        ]);
        var recent = await RecentAsync(store);
        Assert.True(recent.Covered);
        Assert.Null(recent.WaitAttribution);
        Assert.Null(recent.WaitMillisecondsByCategory);
        Assert.Contains("Wait capture is incomplete", recent.Rationale, StringComparison.Ordinal);
    }

    [Fact]
    public async Task IntervalsMerelyTouchingWindowEdgesDoNotContribute()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family", "1", "1", [Plan("plan", "Customer")], runtimeIntervals:
        [
            Interval("plan", "999", Now.AddMinutes(-20)), // Ends exactly at the window's start.
            Interval("plan", "999", Now),
        ]);
        var recent = await RecentAsync(store);
        Assert.False(recent.Covered);
        Assert.Equal("0", recent.TotalWaitMilliseconds);
        Assert.Null(recent.WaitAttribution);
        Assert.Null(recent.WaitMillisecondsByCategory);
    }

    [Fact]
    public void OlderRecentActivityRecordsLeaveNewEvidenceAbsent()
    {
        var recent = JsonSerializer.Deserialize<DatabaseCityRecentActivityV1>("""
            {"WindowMinutes":15,"WindowStart":"2026-09-04T11:45:00Z","WindowEnd":"2026-09-04T12:00:00Z",
             "Covered":true,"ExecutionCount":"1","TotalDurationMicroseconds":"2",
             "TotalWaitMilliseconds":"3","Rationale":"legacy"}
            """)!;
        Assert.Null(recent.WaitAttribution);
        Assert.Null(recent.WaitMillisecondsByCategory);
    }

    private static BigInteger Integer(string value) => BigInteger.Parse(value, CultureInfo.InvariantCulture);

    private static (string, FakeQueryStore.PlanNode[]) Plan(string id, string table) =>
        FakeQueryStore.SizedPlan(id, new FakeQueryStore.PlanNode(FakeQueryStore.Reference(table: table), EstimatedCpu: 1));

    private static FakeQueryStore.RuntimeInterval Interval(
        string planId, string wait, DateTimeOffset start, string category = "CPU") =>
        new(start, start.AddMinutes(5), WaitMilliseconds: wait, PlanId: planId,
            WaitCategories: new Dictionary<string, string> { [category] = wait });

    private static async Task<DatabaseCityRecentActivityV1> RecentAsync(FakeQueryStore store)
    {
        var result = await new QueryStoreCityAttribution(store, timeProvider: new FixedClock()).AttributeAsync(
            FakeQueryStore.DatabaseName, DatabaseCityMetric.Cpu,
            [new("customer", "dbo", "Customer", DatabaseObjectKind.Table),
             new("orders", "dbo", "Orders", DatabaseObjectKind.Table)],
            new Dictionary<string, string>(), 12, default);
        return Assert.Single(result.Families).RecentActivity!;
    }

    private sealed class FixedClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class AdvancingClock : TimeProvider
    {
        public int Reads { get; private set; }
        public override DateTimeOffset GetUtcNow() => Now.AddMilliseconds(Reads++);
    }
}
