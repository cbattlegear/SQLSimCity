using SqlSimCity.Collection.Atlas;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.Atlas;

public sealed class LiveIncidentAtlasActivitySourceTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 17, 18, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task ProjectsOnlyFreshAvailableRequestsForTheSelectedDatabase()
    {
        var response = Response(
            [
                // An idle session: no request, so no request status. It is a live session and
                // counts toward ActiveSessions, but contributes no running request (issue #79).
                Request(1, "AppDb", requestStatus: null, blocker: null),
                Request(2, "AppDb", requestStatus: "running", blocker: 9),
                Request(3, "AppDb", requestStatus: "suspended", blocker: -5),
                Request(4, "AppDb", requestStatus: "running", blocker: 9,
                    availability: SampleAvailability.Disappeared),
                Request(5, "OtherDb", requestStatus: "running", blocker: 9),
            ]);
        var source = new LiveIncidentAtlasActivitySource(() => response, "target");

        var activity = await source.GetActivityAsync(
            "target/database/AppDb", "AppDb", Now, CancellationToken.None);

        Assert.Equal(3, activity.ActiveSessions);
        Assert.Equal(2, activity.RunningRequests);
        Assert.Equal(1, activity.BlockedSessions);
        Assert.Null(activity.BatchRequestsPerSecond);
        Assert.Equal(EvidenceSource.LiveDmvSample, activity.Evidence.Source);
        Assert.Equal(DataStatus.Available, activity.Evidence.Status);
        Assert.Contains("miss", activity.Evidence.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task RequestProbeFailureNeverBecomesMeasuredZero()
    {
        var response = Response(
            [],
            unavailable:
            [
                new UnavailableFieldV1(
                    "requests", DataStatus.PermissionDenied,
                    "The configured principal cannot read active requests."),
            ]);
        var source = new LiveIncidentAtlasActivitySource(() => response, "target");

        var activity = await source.GetActivityAsync(
            "target/database/AppDb", "AppDb", Now, CancellationToken.None);

        Assert.Null(activity.ActiveSessions);
        Assert.Null(activity.RunningRequests);
        Assert.Null(activity.BlockedSessions);
        Assert.Equal(EvidenceSource.LiveDmvSample, activity.Evidence.Source);
        Assert.Equal(DataStatus.PermissionDenied, activity.Evidence.Status);
    }

    [Fact]
    public async Task TargetMismatchCannotMixFixtureOrAnotherServerIntoTheAtlas()
    {
        var source = new LiveIncidentAtlasActivitySource(
            () => Response([Request(1, "AppDb", "running", null)], targetId: "different"),
            "target");

        var activity = await source.GetActivityAsync(
            "target/database/AppDb", "AppDb", Now, CancellationToken.None);

        Assert.Null(activity.ActiveSessions);
        Assert.Equal(DataStatus.Unknown, activity.Evidence.Status);
        Assert.Contains("different target", activity.Evidence.Reason, StringComparison.OrdinalIgnoreCase);
    }

    private static LiveIncidentResponseV1 Response(
        IReadOnlyList<LiveRequestV1> requests,
        IReadOnlyList<UnavailableFieldV1>? unavailable = null,
        string targetId = "target") =>
        new(
            new LiveIncidentSnapshotV1(
                "1.0",
                new LiveIncidentTargetV1(targetId, "Test", "SqlServerOnPremises", "Server", null),
                Now,
                Now,
                Now.AddSeconds(10),
                DataStatus.Available,
                "available",
                requests,
                [],
                new BlockingGraphV1(
                    [], [], [], [],
                    new BlockingGraphSummaryV1(0, 0, 0, 0, 0, "none")),
                [],
                new TempdbUsageV1([], [], [], DataStatus.Available, "available"),
                new FileIoSampleV1([], DataStatus.Available, "available"),
                new SchedulerPressureV1([], DataStatus.Available, "available"),
                new LogSpaceUsageV1(null, null, null, DataStatus.Available, "available"),
                new CollectionDiagnosticsV1(1, Now, Now, 1, 0, 0, unavailable ?? [])),
            new LiveCollectorStatusV1(
                SamplerRunState.Running, 1, Now, Now, 0, null, null, 0, 0));

    private static LiveRequestV1 Request(
        int sessionId,
        string databaseName,
        string? requestStatus,
        long? blocker,
        SampleAvailability availability = SampleAvailability.Available) =>
        new(
            $"req:{sessionId}",
            sessionId,
            null,
            null,
            null,
            "running",
            requestStatus,
            requestStatus is null ? null : "SELECT",
            null,
            null,
            null,
            BlockingReferenceV1.FromRaw(blocker),
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            sessionId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            databaseName,
            null,
            null,
            availability,
            availability == SampleAvailability.Available ? null : "not current",
            PlanCollectionState.NotRequested,
            null);
}
