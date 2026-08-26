using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Atlas;

/// <summary>Projects the latest sampled request rows into per-database atlas activity.</summary>
public sealed class LiveIncidentAtlasActivitySource(
    Func<LiveIncidentResponseV1> currentResponse,
    string expectedTargetId) : ILiveAtlasActivitySource
{
    public ValueTask<LiveActivityV1> GetActivityAsync(
        string databaseId,
        string databaseName,
        DateTimeOffset collectedAt,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var response = currentResponse();
        var snapshot = response.Snapshot;
        if (snapshot is null)
        {
            return ValueTask.FromResult(Unavailable(
                DataStatus.Unknown,
                "The live sampler has not published its first snapshot."));
        }

        if (!string.Equals(snapshot.Target.TargetId, expectedTargetId, StringComparison.Ordinal))
        {
            return ValueTask.FromResult(Unavailable(
                DataStatus.Unknown,
                "The latest live snapshot belongs to a different target and cannot be mixed into this atlas."));
        }

        var requestFailure = snapshot.Diagnostics.UnavailableFields.FirstOrDefault(field =>
            string.Equals(field.Field, "requests", StringComparison.Ordinal));
        if (requestFailure is not null)
        {
            return ValueTask.FromResult(Unavailable(
                requestFailure.Status,
                requestFailure.Reason,
                EvidenceSource.LiveDmvSample,
                snapshot.SourceTimestamp,
                snapshot.FreshUntil));
        }

        var status = snapshot.Status;
        if (status == DataStatus.Available && snapshot.FreshUntil is { } freshUntil && freshUntil < collectedAt)
        {
            status = DataStatus.Stale;
        }

        if (status is not (DataStatus.Available or DataStatus.Stale))
        {
            return ValueTask.FromResult(Unavailable(
                status,
                snapshot.Reason,
                EvidenceSource.LiveDmvSample,
                snapshot.SourceTimestamp,
                snapshot.FreshUntil));
        }

        var requests = snapshot.Requests.Where(request =>
            request.Availability == SampleAvailability.Available &&
            string.Equals(request.DatabaseName, databaseName, StringComparison.OrdinalIgnoreCase)).ToArray();
        var activeSessions = requests.Select(request => request.SessionId).Distinct().Count();
        // Live sampling deliberately asks for idle sessions (@IncludeIdleSessions = true), so this
        // list mixes sessions that are running something with sessions that are merely connected.
        // Only the former are running requests. A row's request status is passed through from
        // sys.dm_exec_requests untouched, and that column is never NULL for a request that exists,
        // so a NULL status is positive evidence of "no request" rather than an unreported state --
        // which is what keeps an idle connection pool out of a concurrency figure (issue #79).
        var runningRequests = requests.Count(request => request.RequestStatus is not null);
        var blockedSessions = requests.Where(request =>
                request.Blocking.BlockingSessionId is not (null or 0 or -5))
            .Select(request => request.SessionId)
            .Distinct()
            .Count();
        var reason = status == DataStatus.Stale
            ? "Counts come from the latest point-in-time DMV sample, which is now stale. Sampling can miss requests that complete between polls."
            : "Counts come from one point-in-time DMV sample. Sampling can miss requests that complete between polls; no batch rate was measured.";
        return ValueTask.FromResult(new LiveActivityV1(
            activeSessions,
            runningRequests,
            blockedSessions,
            null,
            new EvidenceV1(
                EvidenceSource.LiveDmvSample,
                status,
                snapshot.SourceTimestamp,
                snapshot.FreshUntil,
                reason)));
    }

    private static LiveActivityV1 Unavailable(
        DataStatus status,
        string reason,
        EvidenceSource source = EvidenceSource.NotProbed,
        DateTimeOffset? observedAt = null,
        DateTimeOffset? freshUntil = null) =>
        new(
            null,
            null,
            null,
            null,
            new EvidenceV1(source, status, observedAt, freshUntil, reason));
}
