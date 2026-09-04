using SqlSimCity.Collection.Atlas;
using SqlSimCity.Collection.Negotiation;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.SqlServer;

namespace SqlSimCity.Api;

internal sealed record ConnectedCapabilityTarget(
    string TargetId,
    ConnectionProfile Profile,
    IReadOnlyList<string> KnownDatabases,
    TimeSpan RefreshInterval,
    EnginePlatform? Platform = null);

internal sealed class ConnectedCapabilitiesSource(
    ConnectedCapabilityTarget target,
    IProbeExecutor probes,
    TimeProvider timeProvider) : BackgroundService, ICapabilitiesSource
{
    private CapabilitiesSnapshotV1 _snapshot = Pending(target);

    public CapabilitiesSnapshotV1 GetCurrent() => Volatile.Read(ref _snapshot);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                await RefreshAsync(stoppingToken).ConfigureAwait(false);
                await Task.Delay(target.RefreshInterval, timeProvider, stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Host shutdown cancels both negotiation and the cadence wait.
        }
    }

    internal async Task RefreshAsync(CancellationToken cancellationToken)
    {
        var negotiator = new CapabilityNegotiator(new CapabilityCycleProbeExecutor(probes), timeProvider);
        var profile = await negotiator.NegotiateAsync(
            new CapabilityNegotiationRequest(target.TargetId, target.Profile.InitialDatabase),
            cancellationToken).ConfigureAwait(false);
        var databaseNames = new[] { target.Profile.InitialDatabase }
            .Concat(target.KnownDatabases.Count > 0
                ? target.KnownDatabases
                : profile.Databases.Select(database => database.DatabaseName))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(AtlasCollectionOptions.MaximumDatabases + 1)
            .ToArray();
        var queryStore = new Dictionary<string, QueryStoreStateV1>(
            profile.QueryStoreByDatabase, StringComparer.OrdinalIgnoreCase);
        foreach (var databaseName in databaseNames.Skip(1).Take(AtlasCollectionOptions.MaximumDatabases - 1))
        {
            var databaseProfile = await negotiator.NegotiateAsync(
                new CapabilityNegotiationRequest(target.TargetId, databaseName),
                cancellationToken).ConfigureAwait(false);
            foreach (var state in databaseProfile.QueryStoreByDatabase)
                queryStore[state.Key] = state.Value;
        }

        // Target-level feature fields describe the configured initial database, not an
        // optimistic union of different databases' compatibility levels and permissions.
        var truncated = databaseNames.Length > AtlasCollectionOptions.MaximumDatabases ||
            profile.Databases.Count > AtlasCollectionOptions.MaximumDatabases;
        profile = profile with
        {
            Databases = profile.Databases.Take(AtlasCollectionOptions.MaximumDatabases).ToArray(),
            QueryStoreByDatabase = queryStore,
        };
        if (truncated)
        {
            var reason = $"Capability snapshot is bounded to {AtlasCollectionOptions.MaximumDatabases} databases; additional databases may not be represented.";
            profile = profile with
            {
                DatabaseDiscovery = profile.DatabaseDiscovery with
                {
                    Reason = reason,
                    Evidence = profile.DatabaseDiscovery.Evidence with { Reason = reason },
                },
            };
        }
        Volatile.Write(ref _snapshot, new CapabilitiesSnapshotV1("1", timeProvider.GetUtcNow(), [profile]));
    }

    private static CapabilitiesSnapshotV1 Pending(ConnectedCapabilityTarget target)
    {
        const string reason = "Connected capability negotiation has not completed its first cycle.";
        var evidence = new CapabilityEvidenceV1(CapabilityState.NotProbed, reason, null, null, null);
        var feature = new FeatureCapabilityV1(CapabilityState.NotProbed, reason, evidence);
        return new CapabilitiesSnapshotV1("1", DateTimeOffset.UnixEpoch,
        [
            new TargetCapabilityProfileV1(
                "1", target.TargetId, new EnginePlatformV1(EnginePlatform.Unknown, null, null, null, evidence),
                [], feature, new VisibilityV1(VisibilityScope.Unknown, reason, evidence),
                feature, feature, feature, feature, feature, feature,
                new Dictionary<string, QueryStoreStateV1>(StringComparer.OrdinalIgnoreCase),
                new AzureResourceMetricsV1(null, null, evidence), DateTimeOffset.UnixEpoch),
        ]);
    }
}
