using SqlSimCity.Collection.Atlas;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Collection.Tests.LiveIncidents;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.Atlas;

/// <summary>
/// Issue #79. Live sampling asks for idle sessions on purpose (<c>@IncludeIdleSessions = true</c>),
/// so <c>sessions.active_requests</c> returns rows whose <c>sys.dm_exec_requests</c> columns are all
/// NULL. Atlas activity counts a running request per row with a non-null request status, so if the
/// collector invents a status for those rows the concurrency figure counts sessions that are doing
/// nothing.
///
/// These tests run the real <see cref="LiveIncidentCollector"/> and the real
/// <see cref="LiveIncidentAtlasActivitySource"/> together, because the defect lived in the seam
/// between them: each unit was self-consistent, and no test carried a sampled idle row all the way
/// through to the number the atlas reports.
/// </summary>
public sealed class IdleSessionAtlasActivityTests
{
    private static readonly DateTimeOffset EngineStart = new(2024, 1, 1, 0, 0, 0, TimeSpan.Zero);

    // An idle user session: connected, holding no request. Every column the LEFT JOIN to
    // sys.dm_exec_requests would supply is null, which is exactly what the probe returns for it.
    // database_name still resolves, via the probe's COALESCE onto the session's current database.
    // The trailing 0s are the probe's cap-disclosure columns; these tests do not exercise a cap,
    // and the collector floors the visible count at the number of rows it actually received.
    private static ActiveRequestRow IdleSession(int sessionId, string databaseName) => new(
        sessionId, "app_user", "app-host", "MyApp", "sleeping",
        DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch,
        null, null, null, null, null, null, null,
        null, null, null, null, null, null, null,
        7, databaseName, null, null, 0, 1, null, null);

    private static ActiveRequestRow RunningRequest(int sessionId, string databaseName) => new(
        sessionId, "app_user", "app-host", "MyApp", "running",
        null, null, 1, "running", "SELECT", null, null, null, null,
        DateTimeOffset.UnixEpoch, 10, 5, 100, 50, 200, 0,
        7, databaseName, "SELECT 1", "SELECT 1", 0, 1, "SELECT 1".Length, "SELECT 1".Length);

    private static async Task<LiveActivityV1> SampleThenProjectAsync(params ActiveRequestRow[] rows)
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>(rows),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var response = new LiveIncidentResponseV1(
            snapshot,
            new LiveCollectorStatusV1(
                SamplerRunState.Running, 1, snapshot.SourceTimestamp, snapshot.SourceTimestamp, 0, null, null, 0, 0));
        var source = new LiveIncidentAtlasActivitySource(() => response, "target-1");

        // Project at the moment the sample was taken, so freshness never turns this into a
        // staleness test by accident.
        return await source.GetActivityAsync(
            "target-1/database/AppDb", "AppDb", snapshot.CollectedAt, CancellationToken.None);
    }

    [Fact]
    public async Task SampledIdleSessionContributesZeroRunningRequests()
    {
        var activity = await SampleThenProjectAsync(IdleSession(60, "AppDb"));

        Assert.Equal(1, activity.ActiveSessions);
        Assert.Equal(0, activity.RunningRequests);
    }

    [Fact]
    public async Task IdleSessionsDoNotInflateTheCountAlongsideARealRequest()
    {
        var activity = await SampleThenProjectAsync(
            IdleSession(60, "AppDb"),
            IdleSession(62, "AppDb"),
            RunningRequest(61, "AppDb"));

        Assert.Equal(3, activity.ActiveSessions);
        Assert.Equal(1, activity.RunningRequests);
    }

    [Fact]
    public async Task ManyIdleSessionsStillReportNoRunningRequests()
    {
        // The failure mode this guards is proportional to connection-pool size: a mostly-idle pool
        // is the ordinary case, and it is where an inflated figure would be most misleading.
        var idle = Enumerable.Range(100, 25).Select(id => IdleSession(id, "AppDb")).ToArray();

        var activity = await SampleThenProjectAsync(idle);

        Assert.Equal(25, activity.ActiveSessions);
        Assert.Equal(0, activity.RunningRequests);
    }

    [Fact]
    public async Task AnIdleSessionCarriesNoRequestStatusButRemainsIdentifiableAsIdle()
    {
        // "No request" must stay distinguishable from "a request in some state". Null is the
        // truthful value for a row the DMV never reported a status for -- but idleness itself must
        // not become unrecoverable, so it stays readable from the request id and the session status.
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>(
                [IdleSession(60, "AppDb"), RunningRequest(61, "AppDb")]),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var idle = Assert.Single(snapshot.Requests, r => r.SessionId == 60);
        Assert.Null(idle.RequestStatus);
        Assert.Equal("req:60:idle", idle.RequestId);
        Assert.Equal("sleeping", idle.SessionStatus);

        var running = Assert.Single(snapshot.Requests, r => r.SessionId == 61);
        Assert.Equal("running", running.RequestStatus);
    }
}
