using System.Globalization;
using System.Text;
using System.Text.Json;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Ingestion;
using SqlSimCity.Findings.Engine;
using SqlSimCity.Findings.Evidence;

namespace SqlSimCity.Api;

public sealed record EdgeSourceOptions(
    string TargetId,
    TimeSpan StaleAfter,
    TimeSpan DisconnectAfter)
{
    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(TargetId) || TargetId.Length > 128)
            throw new InvalidOperationException("Acquisition:Edge:TargetId must contain 1 to 128 characters.");
        if (StaleAfter < TimeSpan.FromSeconds(5) || StaleAfter > TimeSpan.FromDays(1))
            throw new InvalidOperationException("Acquisition:Edge:StaleAfterSeconds must be between 5 and 86400.");
        if (DisconnectAfter < StaleAfter || DisconnectAfter > TimeSpan.FromDays(7))
            throw new InvalidOperationException("Acquisition:Edge:DisconnectAfterSeconds must be at least StaleAfterSeconds and no more than 604800.");
    }
}

public sealed record EdgeSourceInfo(
    string Source,
    string TargetId,
    string? ConnectorId,
    long? Sequence,
    long? PublicationGeneration,
    string State,
    DateTimeOffset? CapturedAt,
    DateTimeOffset? FreshUntil,
    IReadOnlyList<string> Sections,
    string Qualification);

public sealed class EdgeAcquisitionSource :
    IAtlasSnapshotSource,
    IAtlasCollectorStatusSource,
    ICapabilitiesSource,
    IQueryStoreHistorySource,
    IDatabaseCitySource,
    ILiveIncidentResponseSource,
    IFindingsEvidenceProvider
{
    private readonly Lock _gate = new();
    private readonly EdgeObservationStore _store;
    private readonly EdgeSourceOptions _options;
    private readonly TimeProvider _timeProvider;
    private Projection? _cached;

    public EdgeAcquisitionSource(
        EdgeObservationStore store,
        EdgeSourceOptions options,
        TimeProvider? timeProvider = null)
    {
        _store = store;
        _options = options;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public EdgeSourceInfo Info
    {
        get
        {
            var projection = Current();
            return new EdgeSourceInfo(
                "EdgeConnector",
                _options.TargetId,
                projection.Generation?.ConnectorId,
                projection.Generation?.Sequence,
                projection.Generation?.PublicationGeneration,
                State(projection.Generation).ToString(),
                projection.Generation?.CapturedAt,
                projection.Generation?.Sections.Values
                    .Select(section => section.Freshness.FreshUntil)
                    .Where(value => value is not null)
                    .Min(),
                projection.Generation?.Sections.Keys.Select(value => value.ToString()).Order().ToArray() ?? [],
                "Edge observations are connector-captured point-in-time evidence, not a continuous trace. No central SQL collector is running.");
        }
    }

    public AtlasSnapshotV1 GetCurrent()
    {
        var projection = Current();
        if (projection.Generation is null)
            return EmptyAtlas();

        var section = projection.Generation.Sections[ObservationSection.Atlas];
        var state = State(projection.Generation, ObservationSection.Atlas);
        var stale = state != DataStatus.Available;
        var snapshot = Import(projection.Atlas!.Snapshot, state);
        return snapshot with
        {
            Collection = new AtlasCollectionMetadataV1(
                AtlasCollectorMode.Edge,
                state == DataStatus.Disconnected ? AtlasCollectorState.Disconnected :
                    stale ? AtlasCollectorState.Degraded : AtlasCollectorState.Ready,
                projection.Generation.Sequence,
                section.Freshness.CollectedAt,
                section.Freshness.SourceTimestamp,
                section.Freshness.FreshUntil,
                stale,
                snapshot.Databases.Count,
                0,
                0,
                0,
                $"EdgeConnector generation {projection.Generation.Sequence}; central SQL collection is disabled.")
            {
                RowCount = snapshot.Databases.Count,
            },
        };
    }

    public AtlasCollectorStatusV1 GetStatus()
    {
        var projection = Current();
        if (projection.Generation is null)
            return EmptyAtlas().CollectionStatus();
        var section = projection.Generation.Sections[ObservationSection.Atlas];
        var state = State(projection.Generation, ObservationSection.Atlas);
        return new AtlasCollectorStatusV1(
            AtlasCollectorMode.Edge,
            state == DataStatus.Disconnected ? AtlasCollectorState.Disconnected :
                state == DataStatus.Stale ? AtlasCollectorState.Degraded : AtlasCollectorState.Ready,
            projection.Generation.Sequence,
            section.Freshness.CollectedAt,
            section.Freshness.SourceTimestamp,
            section.Freshness.FreshUntil,
            state != DataStatus.Available,
            projection.Atlas!.Snapshot.Databases.Count,
            0,
            0,
            0,
            0,
            null,
            $"EdgeConnector {state}; no central retry or SQL collection loop is running.");
    }

    CapabilitiesSnapshotV1 ICapabilitiesSource.GetCurrent()
    {
        var projection = Current();
        if (projection.Generation is null)
            return new CapabilitiesSnapshotV1("1", _timeProvider.GetUtcNow(), []);
        return projection.Capabilities! with
        {
            Targets = projection.Capabilities.Targets.Select(Import).ToArray(),
        };
    }

    public LiveIncidentResponseV1 GetCurrentResponse()
    {
        var projection = Current();
        if (projection.Generation is null || projection.Live?.Snapshot is null)
            return new LiveIncidentResponseV1(null, Stopped("No complete EdgeConnector generation has been published."));

        var state = State(projection.Generation, ObservationSection.Live);
        var snapshot = projection.Live.Snapshot;
        return projection.Live with
        {
            Snapshot = snapshot with
            {
                Status = state,
                Reason = $"EdgeConnector point-in-time sample captured at {projection.Generation.CapturedAt:O}; it is static and is not a trace.",
            },
            Collector = Stopped("EdgeConnector live evidence is a static point-in-time sample; no central sampler or SQL connection is running."),
        };
    }

    public Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(
        string? databaseId,
        string metric,
        int pageSize,
        string? pageToken,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var projection = Current();
        if (projection.Generation is null)
            return Task.FromResult(new PageV1<QueryFamilySummaryV1>("1.0", [], null, pageSize, "0")
            {
                Evidence = EdgeQueryEvidence(DataStatus.Disconnected, null, null, "No complete edge generation is available."),
            });

        var sectionState = State(projection.Generation, ObservationSection.QueryStore);
        var query = projection.QueryStore!.Families.Select(value => Import(value, sectionState).Family)
            .Where(value => databaseId is null || string.Equals(value.DatabaseId, databaseId, StringComparison.Ordinal));
        var ordered = metric.ToLowerInvariant() switch
        {
            "execution" or "executions" => query.OrderByDescending(value => Parse(value.ExecutionCount)),
            "duration" => query.OrderByDescending(value => Parse(value.TotalDurationMicroseconds)),
            "reads" => query.OrderByDescending(value => Parse(value.TotalLogicalReads8KiBPages)),
            "waits" => query.OrderByDescending(value => Parse(value.TotalWaitMilliseconds)),
            _ => query.OrderByDescending(value => Parse(value.TotalCpuMicroseconds)),
        };
        var all = ordered.ThenBy(value => value.FamilyId, StringComparer.Ordinal).ToArray();
        var offset = DecodeToken(pageToken, projection.Generation.PublicationGeneration, metric, databaseId, pageSize);
        var items = all.Skip(offset).Take(pageSize).ToArray();
        var next = offset + items.Length < all.Length
            ? EncodeToken(projection.Generation.PublicationGeneration, metric, databaseId, pageSize, offset + items.Length)
            : null;
        var section = projection.Generation.Sections[ObservationSection.QueryStore];
        return Task.FromResult(new PageV1<QueryFamilySummaryV1>(
            "1.0", items, next, pageSize, all.Length.ToString(CultureInfo.InvariantCulture))
        {
            Evidence = items.FirstOrDefault()?.Evidence ??
                EdgeQueryEvidence(State(projection.Generation, ObservationSection.QueryStore),
                    section.Freshness.SourceTimestamp, section.Freshness.FreshUntil, "EdgeConnector Query Store generation."),
        });
    }

    public Task<QueryFamilyDetailV1?> GetFamilyAsync(string familyId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var projection = Current();
        var value = projection.QueryStore?.Families.SingleOrDefault(
            item => string.Equals(item.Family.FamilyId, familyId, StringComparison.Ordinal));
        return Task.FromResult(value is null ? null :
            Import(value, State(projection.Generation, ObservationSection.QueryStore)));
    }

    public Task<NormalizedShowplanV1?> GetPlanAsync(string planId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var projection = Current();
        var value = projection.QueryStore?.Plans.SingleOrDefault(
            item => string.Equals(item.PlanId, planId, StringComparison.Ordinal));
        return Task.FromResult(value is null ? null :
            Import(value, State(projection.Generation, ObservationSection.QueryStore)));
    }

    public Task<PlanComparisonV1?> ComparePlansAsync(
        string leftPlanId,
        string rightPlanId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var projection = Current();
        var left = projection.QueryStore?.Plans.SingleOrDefault(
            value => string.Equals(value.PlanId, leftPlanId, StringComparison.Ordinal));
        var right = projection.QueryStore?.Plans.SingleOrDefault(
            value => string.Equals(value.PlanId, rightPlanId, StringComparison.Ordinal));
        var state = State(projection.Generation, ObservationSection.QueryStore);
        return Task.FromResult(left is null || right is null
            ? null
            : PlanComparer.Compare(Import(left, state), Import(right, state)));
    }

    public async Task<FindingsEvidenceBundle> GetBundleAsync(CancellationToken cancellationToken)
    {
        var provider = new SourceBackedFindingsEvidenceProvider(
            this,
            this,
            this,
            () => GetCurrentResponse().Snapshot,
            _timeProvider);
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var generation = Current().Generation?.PublicationGeneration;
            var bundle = await provider.GetBundleAsync(cancellationToken).ConfigureAwait(false);
            if (generation == Current().Generation?.PublicationGeneration)
                return bundle;
        }
        throw new QueryStoreSnapshotChangedException();
    }

    public Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var projection = Current();
        if (projection.Generation is null)
            return Task.FromResult(new QueryStoreCollectorStatusV1(
                "1.0", QueryStoreCollectorState.Failed, 0, null, null, null, [],
                "No complete EdgeConnector generation is available."));
        var state = State(projection.Generation, ObservationSection.QueryStore);
        return Task.FromResult(projection.QueryStore!.Status with
        {
            State = state == DataStatus.Available ? QueryStoreCollectorState.Ready : QueryStoreCollectorState.Stale,
            Sequence = projection.Generation.Sequence,
            NextAttemptAt = null,
            Reason = $"EdgeConnector {state}; central Query Store collection is disabled.",
        });
    }

    public ValueTask<DatabaseCitySummarySnapshotV1> GetSummariesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var projection = Current();
        return ValueTask.FromResult(projection.DatabaseCity?.Summaries is { } value
            ? Import(value, State(projection.Generation, ObservationSection.DatabaseCity))
            : new DatabaseCitySummarySnapshotV1("1.0", _timeProvider.GetUtcNow(), []));
    }

    public Task<DatabaseCityPageV1?> GetDatabaseAsync(
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize,
        string? pageToken,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var projection = Current();
        if (projection.Generation is null || projection.DatabaseCity is null)
            return Task.FromResult<DatabaseCityPageV1?>(null);
        var page = projection.DatabaseCity.Pages.SingleOrDefault(value =>
            string.Equals(value.DatabaseId, databaseId, StringComparison.Ordinal) && value.Metric == metric);
        if (page is null)
            return Task.FromResult<DatabaseCityPageV1?>(null);
        var offset = DecodeCityToken(
            pageToken, projection.Generation.PublicationGeneration, databaseId, metric, pageSize);
        if (offset > page.Objects.Count)
            throw new DatabaseCityPageTokenException();
        var objects = page.Objects.Skip(offset).Take(pageSize).ToArray();
        var nextOffset = offset + objects.Length;
        var sectionState = State(projection.Generation, ObservationSection.DatabaseCity);
        var imported = Import(page, sectionState);
        return Task.FromResult<DatabaseCityPageV1?>(imported with
        {
            PageSize = pageSize,
            Objects = objects.Select(value => Import(value, sectionState)).ToArray(),
            NextPageToken = nextOffset < page.Objects.Count
                ? EncodeCityToken(projection.Generation.PublicationGeneration, databaseId, metric, pageSize, nextOffset)
                : null,
        });
    }

    private Projection Current()
    {
        lock (_gate)
        {
            // Ask the store for a clone only if the publication generation moved. A cache hit must
            // not deep-copy every section's bytes under the store's global lock, which would also
            // stall ingestion on a read that had nothing new to return.
            var cached = _cached ?? Projection.Empty;
            if (_store.TryGetPublishedGenerationIfChanged(
                    _options.TargetId, cached.Generation?.PublicationGeneration, out var generation))
            {
                cached = generation is null ? Projection.Empty : Deserialize(generation);
            }

            _cached = cached;
            return cached;
        }
    }

    private static Projection Deserialize(PublishedEdgeGeneration generation) => new(
        generation,
        Read<AtlasObservationV1>(generation, ObservationSection.Atlas),
        Read<CapabilitiesSnapshotV1>(generation, ObservationSection.Capabilities),
        Read<QueryStoreObservationV1>(generation, ObservationSection.QueryStore),
        Read<DatabaseCityObservationV1>(generation, ObservationSection.DatabaseCity),
        Read<LiveIncidentResponseV1>(generation, ObservationSection.Live));

    private static T Read<T>(PublishedEdgeGeneration generation, ObservationSection section) =>
        JsonSerializer.Deserialize<T>(generation.Sections[section].Content, EdgeJson.Options)
        ?? throw new JsonException($"Edge {section} payload is empty.");

    private DataStatus State(PublishedEdgeGeneration? generation, ObservationSection section)
    {
        if (generation is null)
            return DataStatus.Disconnected;
        var now = _timeProvider.GetUtcNow();
        if (now - generation.CapturedAt > _options.DisconnectAfter)
            return DataStatus.Disconnected;
        var freshness = generation.Sections[section].Freshness;
        var staleAt = freshness.FreshUntil ?? generation.CapturedAt + _options.StaleAfter;
        return now > staleAt ? DataStatus.Stale : DataStatus.Available;
    }

    private DataStatus State(PublishedEdgeGeneration? generation)
    {
        if (generation is null)
            return DataStatus.Disconnected;
        var states = Enum.GetValues<ObservationSection>()
            .Select(section => State(generation, section))
            .ToArray();
        if (states.Contains(DataStatus.Disconnected))
            return DataStatus.Disconnected;
        return states.Contains(DataStatus.Stale) ? DataStatus.Stale : DataStatus.Available;
    }

    private AtlasSnapshotV1 EmptyAtlas() => new(
        "1.0",
        "edge-awaiting-generation",
        new AtlasTargetV1(_options.TargetId, _options.TargetId, "Unknown"),
        _timeProvider.GetUtcNow(),
        [],
        [])
    {
        Collection = new AtlasCollectionMetadataV1(
            AtlasCollectorMode.Edge, AtlasCollectorState.Disconnected, 0, null, null, null, true,
            0, 0, 0, 0, "No complete EdgeConnector generation has been published."),
    };

    private static AtlasSnapshotV1 Import(AtlasSnapshotV1 value, DataStatus state) => value with
    {
        Databases = value.Databases.Select(database => database with
        {
            Allocated = database.Allocated with { Evidence = Import(database.Allocated.Evidence, state) },
            Used = database.Used with { Evidence = Import(database.Used.Evidence, state) },
            LiveActivity = database.LiveActivity with { Evidence = Import(database.LiveActivity.Evidence, state) },
            QueryStore = database.QueryStore with { Evidence = Import(database.QueryStore.Evidence, state) },
            LogAllocated = database.LogAllocated is null ? null : database.LogAllocated with { Evidence = Import(database.LogAllocated.Evidence, state) },
            LogUsed = database.LogUsed is null ? null : database.LogUsed with { Evidence = Import(database.LogUsed.Evidence, state) },
            FileIo = database.FileIo is null ? null : database.FileIo with { Evidence = Import(database.FileIo.Evidence, state) },
        }).ToArray(),
        Edges = value.Edges.Select(edge => edge with { Evidence = Import(edge.Evidence, state) }).ToArray(),
    };

    private static EvidenceV1 Import(EvidenceV1 value, DataStatus state) => value with
    {
        Source = EvidenceSource.EdgeConnector,
        Status = EffectiveStatus(value.Status, state),
        Reason = $"EdgeConnector: {value.Reason}",
    };

    private static TargetCapabilityProfileV1 Import(TargetCapabilityProfileV1 value) => value with
    {
        Platform = value.Platform with { Evidence = Import(value.Platform.Evidence) },
        Databases = value.Databases.Select(database => database with { Evidence = Import(database.Evidence) }).ToArray(),
        DatabaseDiscovery = value.DatabaseDiscovery with { Evidence = Import(value.DatabaseDiscovery.Evidence) },
        ServerVisibility = value.ServerVisibility with { Evidence = Import(value.ServerVisibility.Evidence) },
        Waits = value.Waits with { Evidence = Import(value.Waits.Evidence) },
        LiveSessions = value.LiveSessions with { Evidence = Import(value.LiveSessions.Evidence) },
        PlansAndText = value.PlansAndText with { Evidence = Import(value.PlansAndText.Evidence) },
        ParameterSensitivePlan = value.ParameterSensitivePlan with { Evidence = Import(value.ParameterSensitivePlan.Evidence) },
        OptionalParameterPlanOptimization = value.OptionalParameterPlanOptimization with { Evidence = Import(value.OptionalParameterPlanOptimization.Evidence) },
        ReadableSecondaryQueryStore = value.ReadableSecondaryQueryStore with { Evidence = Import(value.ReadableSecondaryQueryStore.Evidence) },
        QueryStoreByDatabase = value.QueryStoreByDatabase.ToDictionary(
            pair => pair.Key, pair => pair.Value with { Evidence = Import(pair.Value.Evidence) }, StringComparer.Ordinal),
        AzureResourceMetrics = value.AzureResourceMetrics with { Evidence = Import(value.AzureResourceMetrics.Evidence) },
    };

    private static CapabilityEvidenceV1 Import(CapabilityEvidenceV1 value) =>
        value with { Reason = $"EdgeConnector: {value.Reason}" };

    private static QueryStoreEvidenceV1 Import(QueryStoreEvidenceV1 value, DataStatus state) => value with
    {
        Source = QueryStoreSource.EdgeConnector,
        Status = EffectiveStatus(value.Status, state),
        Reason = $"EdgeConnector: {value.Reason}",
        Caveat = $"EdgeConnector point-in-time generation. {value.Caveat}",
    };

    private static QueryFamilyDetailV1 Import(QueryFamilyDetailV1 value, DataStatus state) => value with
    {
        Family = value.Family with { Evidence = Import(value.Family.Evidence, state) },
        Plans = value.Plans.Select(plan => plan with { Evidence = Import(plan.Evidence, state) }).ToArray(),
        Runtime = value.Runtime.Select(runtime => runtime with { Evidence = Import(runtime.Evidence, state) }).ToArray(),
    };

    private static NormalizedShowplanV1 Import(NormalizedShowplanV1 value, DataStatus state) => value with
    {
        Evidence = Import(value.Evidence, state),
        RuntimeOverlayCaveat = $"EdgeConnector point-in-time generation. {value.RuntimeOverlayCaveat}",
    };

    private static DatabaseCitySummarySnapshotV1 Import(DatabaseCitySummarySnapshotV1 value, DataStatus state) => value with
    {
        Databases = value.Databases.Select(database => database with { Evidence = Import(database.Evidence, state) }).ToArray(),
    };

    private static DatabaseCityPageV1 Import(DatabaseCityPageV1 value, DataStatus state) => value with
    {
        Evidence = Import(value.Evidence, state),
        Schemas = value.Schemas.Select(schema => schema with { Evidence = Import(schema.Evidence, state) }).ToArray(),
        Objects = value.Objects.Select(item => Import(item, state)).ToArray(),
        TopQueryFamilies = value.TopQueryFamilies.Select(family => family with { Evidence = Import(family.Evidence, state) }).ToArray(),
        OtherWorkload = value.OtherWorkload with { Evidence = Import(value.OtherWorkload.Evidence, state) },
        Routes = value.Routes.Select(route => route with { Evidence = Import(route.Evidence, state) }).ToArray(),
    };

    private static DatabaseCityObjectV1 Import(DatabaseCityObjectV1 value, DataStatus state) => value with
    {
        DirectActivity = value.DirectActivity with { Evidence = Import(value.DirectActivity.Evidence, state) },
        AttributedExposure = value.AttributedExposure with { Evidence = Import(value.AttributedExposure.Evidence, state) },
        Indexes = value.Indexes.Select(index => index with
        {
            DirectActivity = index.DirectActivity with { Evidence = Import(index.DirectActivity.Evidence, state) },
        }).ToArray(),
    };

    internal static DataStatus EffectiveStatus(DataStatus payload, DataStatus edge)
    {
        if (edge == DataStatus.Available)
            return payload;
        return payload is DataStatus.Available or DataStatus.Stale ? edge : payload;
    }

    private static QueryStoreEvidenceV1 EdgeQueryEvidence(
        DataStatus state,
        DateTimeOffset? observedAt,
        DateTimeOffset? freshUntil,
        string reason) =>
        new(QueryStoreSource.EdgeConnector, state, observedAt, freshUntil, reason,
            "Connector-captured point-in-time aggregate; not operator progress or a continuous trace.");

    private static LiveCollectorStatusV1 Stopped(string reason) =>
        new(SamplerRunState.Stopped, 0, null, null, 0, null, reason, 0, 0);

    private static decimal Parse(string value) => decimal.Parse(value, CultureInfo.InvariantCulture);

    private static string EncodeToken(long generation, string metric, string? databaseId, int pageSize, int offset) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(
            $"{generation}|{metric}|{databaseId ?? "*"}|{pageSize}|{offset}"));

    private static int DecodeToken(string? token, long generation, string metric, string? databaseId, int pageSize)
    {
        if (token is null)
            return 0;
        try
        {
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(token)).Split('|');
            if (parts.Length != 5 ||
                parts[0] != generation.ToString(CultureInfo.InvariantCulture) ||
                parts[1] != metric ||
                parts[2] != (databaseId ?? "*") ||
                parts[3] != pageSize.ToString(CultureInfo.InvariantCulture) ||
                !int.TryParse(parts[4], NumberStyles.None, CultureInfo.InvariantCulture, out var offset) ||
                offset < 0)
                throw new QueryStorePageTokenException("The edge page token is invalid or belongs to another generation.");
            return offset;
        }
        catch (FormatException)
        {
            throw new QueryStorePageTokenException("The edge page token is malformed.");
        }
    }

    private static string EncodeCityToken(
        long generation, string databaseId, DatabaseCityMetric metric, int pageSize, int offset) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(
            $"{generation}|{databaseId}|{metric}|{pageSize}|{offset}"));

    private static int DecodeCityToken(
        string? token, long generation, string databaseId, DatabaseCityMetric metric, int pageSize)
    {
        if (token is null)
            return 0;
        try
        {
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(token)).Split('|');
            if (parts.Length != 5 ||
                parts[0] != generation.ToString(CultureInfo.InvariantCulture) ||
                parts[1] != databaseId ||
                parts[2] != metric.ToString() ||
                parts[3] != pageSize.ToString(CultureInfo.InvariantCulture) ||
                !int.TryParse(parts[4], NumberStyles.None, CultureInfo.InvariantCulture, out var offset) ||
                offset < 0)
                throw new DatabaseCityPageTokenException();
            return offset;
        }
        catch (FormatException)
        {
            throw new DatabaseCityPageTokenException();
        }
    }

    private sealed record Projection(
        PublishedEdgeGeneration? Generation,
        AtlasObservationV1? Atlas,
        CapabilitiesSnapshotV1? Capabilities,
        QueryStoreObservationV1? QueryStore,
        DatabaseCityObservationV1? DatabaseCity,
        LiveIncidentResponseV1? Live)
    {
        public static Projection Empty { get; } = new(null, null, null, null, null, null);
    }
}

internal static class EdgeAtlasExtensions
{
    public static AtlasCollectorStatusV1 CollectionStatus(this AtlasSnapshotV1 snapshot)
    {
        var collection = snapshot.Collection!;
        return new AtlasCollectorStatusV1(
            collection.Mode, collection.State, collection.Sequence, collection.CollectedAt,
            collection.SourceTimestamp, collection.StaleAfter, collection.IsStale,
            collection.DatabaseCount, collection.FailureCount, collection.SkipCount,
            collection.DurationMilliseconds, 0, null, collection.Reason)
        {
            RowCount = collection.RowCount,
        };
    }
}
