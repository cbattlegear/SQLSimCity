using SqlSimCity.Collection.Atlas;
using SqlSimCity.Collection.Catalog;
using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Negotiation;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;
using SqlSimCity.Storage;

namespace SqlSimCity.Edge.Connector;

public sealed class ConnectedObservationProvider : IObservationProvider, IAsyncDisposable
{
    private const int MaximumQueryFamilies = 200;
    private readonly ConnectedSourceOptions _options;
    private readonly ConnectedObservationState _state;
    private readonly ILiveIncidentCollector _liveCollector;
    private readonly AtlasCollector _atlasCollector;
    private readonly ICapabilityNegotiator _capabilityNegotiator;
    private readonly IQueryStoreIncrementalSource _queryIncrementalSource;
    private readonly IncrementalQueryStoreCollector _queryCollector;
    private readonly IQueryStoreHistorySource _querySource;
    private readonly IDatabaseCitySource _databaseCity;
    private readonly IReadOnlyList<IDisposable> _ownedDisposables;
    private readonly IReadOnlyList<IAsyncDisposable> _ownedAsyncDisposables;
    private long _cycleSequence;
    private int _disposed;

    internal ConnectedObservationProvider(
        ConnectedSourceOptions options,
        ConnectedObservationState state,
        ILiveIncidentCollector liveCollector,
        AtlasCollector atlasCollector,
        ICapabilityNegotiator capabilityNegotiator,
        IQueryStoreIncrementalSource queryIncrementalSource,
        IncrementalQueryStoreCollector queryCollector,
        IQueryStoreHistorySource querySource,
        IDatabaseCitySource databaseCity,
        IReadOnlyList<IDisposable>? ownedDisposables = null,
        IReadOnlyList<IAsyncDisposable>? ownedAsyncDisposables = null)
    {
        _options = options;
        _state = state;
        _liveCollector = liveCollector;
        _atlasCollector = atlasCollector;
        _capabilityNegotiator = capabilityNegotiator;
        _queryIncrementalSource = queryIncrementalSource;
        _queryCollector = queryCollector;
        _querySource = querySource;
        _databaseCity = databaseCity;
        _ownedDisposables = ownedDisposables ?? [];
        _ownedAsyncDisposables = ownedAsyncDisposables ?? [];
    }

    public static async Task<ConnectedObservationProvider> CreateAsync(
        ConnectedSourceOptions options,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(options);
        var timeProvider = TimeProvider.System;
        var catalog = ProbeCatalog.Load();
        ISecretFileProvider secrets;
        try
        {
            secrets = options.InlineSecrets ?? new FileSecretFileProvider(options.SecretFiles);
        }
        catch (Exception ex) when (
            ex is ArgumentException or PathTooLongException or NotSupportedException)
        {
            throw new ConnectorConfigurationException(
                "Connected SQL secret-store configuration is invalid.");
        }
        await ValidateAuthenticationFilesAsync(
            options.Profile.Authentication, secrets, cancellationToken).ConfigureAwait(false);
        var connectionFactory = new SqlConnectionFactory(secrets);
        VolatileProtectedRecordStore? volatileStore = null;
        SqlQueryStoreIncrementalSource? incrementalSource = null;
        IncrementalQueryStoreCollector? queryCollector = null;
        try
        {
            var state = new ConnectedObservationState(options);
            var liveExecutor = new SqlLiveIncidentProbeExecutor(
                connectionFactory, options.Profile, catalog, options.Platform,
                includeSqlText: false);
            var liveCollector = new LiveIncidentCollector(
                liveExecutor,
                options.Atlas.TargetId,
                options.TargetDisplayName,
                timeProvider,
                configuredPlatform: options.Platform);
            var atlasExecutor = new SqlClientAtlasProbeExecutor(
                connectionFactory, options.Profile, catalog, timeProvider, options.Platform);
            var atlasCollector = new AtlasCollector(
                atlasExecutor,
                new LiveIncidentAtlasActivitySource(
                    () => state.GetCurrentResponse(), options.Atlas.TargetId),
                options.Atlas,
                timeProvider);
            var capabilityNegotiator = new CapabilityNegotiator(
                new SqlClientProbeExecutor(
                    connectionFactory, options.Profile, catalog, options.Platform),
                timeProvider);

            volatileStore = new VolatileProtectedRecordStore();
            var repository = new ProtectedQueryStoreRepository(volatileStore);
            var statusTracker = new QueryStoreCollectionStatusTracker();
            incrementalSource = new SqlQueryStoreIncrementalSource(
                connectionFactory, options.Profile, catalog, timeProvider, options.Platform);
            var sink = new ProtectedQueryStoreHistorySink(repository, statusTracker);
            queryCollector = new IncrementalQueryStoreCollector(
                incrementalSource, sink, options.QueryStore, timeProvider);
            var querySource = new ConnectedQueryStoreHistorySource(
                repository, incrementalSource, new SecureShowplanParser(), statusTracker, timeProvider,
                allowRawPayloadHydration: false);
            var cityExecutor = new SqlClientDatabaseCityProbeExecutor(
                connectionFactory, options.Profile, catalog, timeProvider);
            var citySource = new ConnectedDatabaseCitySource(state, cityExecutor, targetId: options.Atlas.TargetId);
            return new ConnectedObservationProvider(
                options,
                state,
                liveCollector,
                atlasCollector,
                capabilityNegotiator,
                incrementalSource,
                queryCollector,
                querySource,
                citySource,
                [queryCollector, incrementalSource, volatileStore],
                [connectionFactory]);
        }
        catch
        {
            queryCollector?.Dispose();
            incrementalSource?.Dispose();
            volatileStore?.Dispose();
            await connectionFactory.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<IReadOnlyList<ObservationInput>> CollectAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(
            Volatile.Read(ref _disposed) != 0, this);
        var sequence = Interlocked.Increment(ref _cycleSequence);

        var liveSnapshot = ConnectorObservationSanitizer.Live(await _liveCollector
            .CollectAsync(sequence, cancellationToken).ConfigureAwait(false));
        var live = new LiveIncidentResponseV1(
            liveSnapshot,
            new LiveCollectorStatusV1(
                SamplerRunState.Stopped,
                sequence,
                now,
                now,
                0,
                null,
                "The edge connector captured one point-in-time sample; no continuous sampler is running.",
                0,
                0));
        _state.PublishLive(live);

        var collectedAtlas = await _atlasCollector
            .CollectAsync(sequence, cancellationToken).ConfigureAwait(false);
        var atlasResult = collectedAtlas with
        {
            Snapshot = collectedAtlas.Snapshot with
            {
                Target = collectedAtlas.Snapshot.Target with
                {
                    Platform = PlatformLabel(_options.Platform),
                },
            },
        };
        _state.PublishAtlas(atlasResult.Snapshot);

        var capabilities = new CapabilitiesSnapshotV1(
            "1",
            now,
            [await _capabilityNegotiator.NegotiateAsync(
                new CapabilityNegotiationRequest(
                    _options.Atlas.TargetId, _options.Profile.InitialDatabase),
                cancellationToken).ConfigureAwait(false)]);

        QueryStoreObservationV1 queryStore;
        try
        {
            var queryDatabases = await ResolveQueryDatabasesAsync(cancellationToken)
                .ConfigureAwait(false);
            await _queryCollector.CollectAsync(
                queryDatabases, now, cancellationToken).ConfigureAwait(false);
            queryStore = await BuildQueryStoreAsync(cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (
            ex is InvalidOperationException or InvalidDataException or ProbeExecutionException)
        {
            queryStore = new QueryStoreObservationV1(
                new QueryStoreCollectorStatusV1(
                    "1.0",
                    QueryStoreCollectorState.Failed,
                    sequence,
                    now,
                    null,
                    null,
                    [],
                    "Connected edge Query Store evidence is unavailable for this cycle."),
                [],
                []);
        }
        var city = await BuildDatabaseCityAsync(cancellationToken)
            .ConfigureAwait(false);
        city = BindQueryStoreNamespaces(city, atlasResult.Snapshot, queryStore);

        return
        [
            new ObservationInput(
                ObservationSection.Atlas,
                new ObservationFreshnessV1(
                    atlasResult.Snapshot.Collection?.SourceTimestamp,
                    atlasResult.Snapshot.Collection?.CollectedAt ?? now,
                    atlasResult.Snapshot.Collection?.StaleAfter),
                new AtlasObservationV1(atlasResult.Snapshot, atlasResult.Status)),
            new ObservationInput(
                ObservationSection.Capabilities,
                new ObservationFreshnessV1(capabilities.GeneratedAt, now, null),
                capabilities),
            new ObservationInput(
                ObservationSection.QueryStore,
                new ObservationFreshnessV1(
                    queryStore.Status.LastPublishedAt, now, null),
                queryStore),
            new ObservationInput(
                ObservationSection.DatabaseCity,
                new ObservationFreshnessV1(city.Summaries.GeneratedAt, now, null),
                city),
            new ObservationInput(
                ObservationSection.Live,
                new ObservationFreshnessV1(
                    liveSnapshot.SourceTimestamp,
                    liveSnapshot.CollectedAt,
                    liveSnapshot.FreshUntil),
                live),
        ];
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
            return;
        foreach (var disposable in _ownedDisposables)
            disposable.Dispose();
        foreach (var disposable in _ownedAsyncDisposables)
            await disposable.DisposeAsync().ConfigureAwait(false);
    }

    private async Task<IReadOnlyList<string>> ResolveQueryDatabasesAsync(
        CancellationToken cancellationToken)
    {
        if (_options.KnownDatabases.Count > 0)
            return _options.KnownDatabases;
        return (await _queryIncrementalSource.DiscoverDatabasesAsync(cancellationToken)
                .ConfigureAwait(false))
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(AtlasCollectionOptions.MaximumDatabases)
            .ToArray();
    }

    private async Task<QueryStoreObservationV1> BuildQueryStoreAsync(
        CancellationToken cancellationToken)
    {
        var page = await _querySource.GetQueriesAsync(
            null, "cpu", MaximumQueryFamilies, null, cancellationToken)
            .ConfigureAwait(false);
        var families = new List<QueryFamilyDetailV1>(page.Items.Count);
        foreach (var summary in page.Items)
        {
            if (await _querySource.GetFamilyAsync(
                    summary.FamilyId, cancellationToken).ConfigureAwait(false) is { } family)
                families.Add(ConnectorObservationSanitizer.QueryFamily(family));
        }
        return new QueryStoreObservationV1(
            await _querySource.GetStatusAsync(cancellationToken).ConfigureAwait(false),
            families,
            []);
    }

    private DatabaseCityObservationV1 BindQueryStoreNamespaces(
        DatabaseCityObservationV1 city, AtlasSnapshotV1 atlas, QueryStoreObservationV1 queryStore)
    {
        var catalog = atlas.Databases.GroupBy(value => value.DatabaseId, StringComparer.Ordinal)
            .Where(group => group.Count() == 1)
            .ToDictionary(group => group.Key, group => group.Single(), StringComparer.Ordinal);
        var names = atlas.Databases.ToLookup(value => value.Name, StringComparer.OrdinalIgnoreCase);
        var namespaces = queryStore.Families.Select(value => value.Family.DatabaseId)
            .Where(value => !string.IsNullOrWhiteSpace(value)).Distinct(StringComparer.Ordinal)
            .ToLookup(value => value, StringComparer.OrdinalIgnoreCase);
        return city with
        {
            Pages = city.Pages.Select(page =>
            {
                string? resolved = null;
                if (atlas.Target.TargetId == _options.Atlas.TargetId &&
                    catalog.TryGetValue(page.DatabaseId, out var database) &&
                    names[database.Name].Count() == 1 &&
                    (database.DatabaseId == $"{_options.Atlas.TargetId}/database/{Uri.EscapeDataString(database.Name)}" ||
                     (database.DatabaseId.StartsWith($"{_options.Atlas.TargetId}/resource/", StringComparison.Ordinal) &&
                      database.DatabaseId.Length > _options.Atlas.TargetId.Length + "/resource/".Length)))
                {
                    var candidates = namespaces[database.Name].ToArray();
                    if (candidates.Length == 1)
                        resolved = candidates[0];
                }
                return page with { QueryStoreDatabaseId = resolved };
            }).ToArray(),
        };
    }

    private async Task<DatabaseCityObservationV1> BuildDatabaseCityAsync(
        CancellationToken cancellationToken)
    {
        var summaries = await _databaseCity.GetSummariesAsync(cancellationToken)
            .ConfigureAwait(false);
        var pages = new List<DatabaseCityPageV1>(
            summaries.Databases.Count * Enum.GetValues<DatabaseCityMetric>().Length);
        foreach (var database in summaries.Databases)
        foreach (var metric in Enum.GetValues<DatabaseCityMetric>())
        {
            if (await _databaseCity.GetDatabaseAsync(
                    database.DatabaseId,
                    metric,
                    50,
                    null,
                    cancellationToken).ConfigureAwait(false) is { } page)
                pages.Add(page);
        }
        return new DatabaseCityObservationV1(summaries, pages);
    }

    private static async Task ValidateAuthenticationFilesAsync(
        AuthenticationStrategy authentication,
        ISecretFileProvider provider,
        CancellationToken cancellationToken)
    {
        var references = authentication switch
        {
            SqlLoginAuthenticationStrategy sql =>
                [sql.PasswordSecretReference],
            ServicePrincipalSecretAuthenticationStrategy secret =>
                [secret.ClientSecretReference],
            ServicePrincipalCertificateAuthenticationStrategy certificate
                when certificate.CertificatePasswordSecretReference is { } password =>
                [certificate.CertificateSecretReference, password],
            ServicePrincipalCertificateAuthenticationStrategy certificate =>
                [certificate.CertificateSecretReference],
            _ => Array.Empty<SecretFileReference>(),
        };
        try
        {
            foreach (var reference in references)
            {
                using var value = await provider.ReadAsync(reference, cancellationToken)
                    .ConfigureAwait(false);
                if (value.Length == 0)
                    throw new SecretResolutionException("Configured secret file is empty.");
            }
            if (authentication is WorkloadIdentityAuthenticationStrategy workload &&
                workload.FederatedTokenFilePath is { } path)
            {
                var reference = new SecretFileReference(Path.GetFileName(path));
                using var value = await provider.ReadAsync(reference, cancellationToken)
                    .ConfigureAwait(false);
                if (value.Length == 0)
                    throw new SecretResolutionException("Configured secret file is empty.");
            }

        }
        catch (SecretResolutionException)
        {
            throw new ConnectorConfigurationException(
                "A configured SQL authentication secret file is missing, invalid, empty, or unreadable.");
        }
    }

    private static string PlatformLabel(EnginePlatform platform) => platform switch
    {
        EnginePlatform.SqlServerOnPremises => "SQL Server",
        EnginePlatform.AzureSqlDatabase => "Azure SQL Database",
        EnginePlatform.AzureSqlManagedInstance => "Azure SQL Managed Instance",
        _ => "Unknown",
    };
}

internal static class ConnectorObservationSanitizer
{
    public static LiveIncidentSnapshotV1 Live(
        LiveIncidentSnapshotV1 snapshot) => snapshot with
    {
        Requests = snapshot.Requests.Select(request => request with
        {
            LoginName = null,
            HostName = null,
            ProgramName = null,
            BatchText = null,
            CurrentStatementText = null,
        }).ToArray(),
        MemoryGrants = snapshot.MemoryGrants.Select(grant => grant with
        {
            BatchText = null,
        }).ToArray(),
        // Completed queries carry statement text for the same reason active requests do, and it is
        // stripped here for the same reason: the connector's contract is that no query text leaves
        // the customer's network. The executions, timings and hashes survive, so the map still moves
        // -- what is removed is only the text a viewer could read.
        CompletedQueries = snapshot.CompletedQueries with
        {
            Queries = snapshot.CompletedQueries.Queries.Select(query => query with
            {
                StatementText = null,
            }).ToArray(),
        },
    };

    public static QueryFamilyDetailV1 QueryFamily(
        QueryFamilyDetailV1 family) => family with
    {
        Family = family.Family with
        {
            Text = QueryText(family.Family.Text),
            PhysicalQueries = family.Family.PhysicalQueries.Select(query => query with
            {
                Text = QueryText(query.Text),
            }).ToArray(),
        },
    };

    private static QueryTextDescriptorV1 QueryText(
        QueryTextDescriptorV1 descriptor) => descriptor with
    {
        Availability = descriptor.Availability == QueryTextAvailability.Encrypted
            ? QueryTextAvailability.Encrypted
            : QueryTextAvailability.Restricted,
        NormalizedText = null,
        Reason = "Query text is not fetched or transmitted by the edge connector.",
    };
}

internal sealed class ConnectedObservationState : IAtlasSnapshotSource
{
    private AtlasSnapshotV1 _atlas;
    private LiveIncidentResponseV1 _live;

    public ConnectedObservationState(ConnectedSourceOptions options)
    {
        _atlas = new AtlasSnapshotV1(
            "1.0",
            $"{options.Atlas.TargetId}/awaiting-first-cycle",
            new AtlasTargetV1(
                options.Atlas.TargetId,
                options.TargetDisplayName,
                options.Platform.ToString()),
            DateTimeOffset.UnixEpoch,
            [],
            []);
        _live = new LiveIncidentResponseV1(
            null,
            new LiveCollectorStatusV1(
                SamplerRunState.Stopped, 0, null, null, 0, null,
                "No connected edge cycle has completed.", 0, 0));
    }

    public AtlasSnapshotV1 GetCurrent() => Volatile.Read(ref _atlas);

    public LiveIncidentResponseV1 GetCurrentResponse() => Volatile.Read(ref _live);

    public void PublishAtlas(AtlasSnapshotV1 value) => Volatile.Write(ref _atlas, value);

    public void PublishLive(LiveIncidentResponseV1 value) => Volatile.Write(ref _live, value);
}
