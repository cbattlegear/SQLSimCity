using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Archive;

public sealed partial class ArchiveSource :
    IAtlasSnapshotSource,
    IAtlasCollectorStatusSource,
    ICapabilitiesSource,
    IQueryStoreHistorySource,
    IDatabaseCitySource,
    ILiveIncidentResponseSource,
    IDisposable
{
    public const string AtlasSnapshotEntry = "atlas/snapshot.json";
    public const string AtlasStatusEntry = "atlas/status.json";
    public const string CapabilitiesEntry = "capabilities/snapshot.json";
    public const string LiveResponseEntry = "live/response.json";
    public const string QueryStoreStatusEntry = "query-store/status.json";
    public const string QueryStoreIndexEntry = "query-store/index.json";
    public const string CitySummariesEntry = "database-city/summaries.json";
    public const string CityIndexEntry = "database-city/index.json";

    private readonly ArchivePackage _package;
    private readonly ArchiveRedactor _redactor;
    private readonly AtlasSnapshotV1 _atlas;
    private readonly AtlasCollectorStatusV1 _atlasStatus;
    private readonly CapabilitiesSnapshotV1 _capabilities;
    private readonly LiveIncidentResponseV1 _live;
    private readonly QueryStoreCollectorStatusV1 _queryStoreStatus;
    private readonly QueryStoreArchiveIndex _queryStoreIndex;
    private readonly DatabaseCitySummarySnapshotV1 _citySummaries;
    private readonly DatabaseCityArchiveIndex _cityIndex;

    private ArchiveSource(ArchivePackage package)
    {
        _package = package;
        _redactor = new ArchiveRedactor(package.Manifest.Redaction.ProtectedIdentifiersIncluded);
        RequireFeatures(package.Manifest);
        var archivedAtlas = _redactor.Redact(
            ReadRequired<AtlasSnapshotV1>(AtlasSnapshotEntry),
            package.Manifest.Target.DisplayAlias);
        _atlas = Import(archivedAtlas);
        _atlasStatus = ReadOptional<AtlasCollectorStatusV1>(AtlasStatusEntry) ??
            new AtlasCollectorStatusV1(
                AtlasCollectorMode.Archive, AtlasCollectorState.Ready, 0,
                _atlas.GeneratedAt, _atlas.GeneratedAt, _atlas.GeneratedAt, true,
                _atlas.Databases.Count, 0, 0, 0, 0, null,
                "Imported archive; no SQL Server collector is running.");
        _capabilities = Import(_redactor.Redact(
            ReadOptional<CapabilitiesSnapshotV1>(CapabilitiesEntry) ??
            new CapabilitiesSnapshotV1("1", package.Manifest.CreatedAt, [])),
            archivedAtlas.Target.TargetId);
        _live = Import(_redactor.Redact(
            ReadOptional<LiveIncidentResponseV1>(LiveResponseEntry) ??
            new LiveIncidentResponseV1(null, StoppedCollector("Archive contains no live point-in-time sample."))));
        _queryStoreStatus = _redactor.Redact(
            ReadOptional<QueryStoreCollectorStatusV1>(QueryStoreStatusEntry) ??
            new QueryStoreCollectorStatusV1(
                "1.0", QueryStoreCollectorState.Disabled, 0, null, null, null, [],
                "Archive contains no Query Store history section."));
        _queryStoreIndex = ReadOptional<QueryStoreArchiveIndex>(QueryStoreIndexEntry) ??
            new QueryStoreArchiveIndex(
                new Dictionary<string, string>(StringComparer.Ordinal),
                new Dictionary<string, string>(StringComparer.Ordinal),
                new Dictionary<string, ArchivePageSeries>(StringComparer.Ordinal));
        _citySummaries = Import(_redactor.Redact(
            ReadOptional<DatabaseCitySummarySnapshotV1>(CitySummariesEntry) ??
            new DatabaseCitySummarySnapshotV1("1.0", package.Manifest.CreatedAt, [])));
        _cityIndex = ReadOptional<DatabaseCityArchiveIndex>(CityIndexEntry) ??
            new DatabaseCityArchiveIndex(
                new Dictionary<string, IReadOnlyDictionary<string, ArchivePageSeries>>(StringComparer.Ordinal));
        ValidateIndexes();
        ValidateLegacyFindings();
    }

    public ArchiveInfo Info => new(
        ArchiveFormat.SourceLabel,
        _package.Manifest.SchemaVersion,
        _package.Manifest.ProducerVersion,
        _package.Manifest.CreatedAt,
        _package.Manifest.Target,
        _package.Manifest.IncludedSections.Where(section => section != "findings").ToArray(),
        _package.Manifest.Redaction,
        _package.Manifest.Features.Where(feature => feature != LegacyFindingsFeature).ToArray(),
        _package.Manifest.Capabilities
            .Where(capability => capability != "offline-findings-reevaluation").ToArray(),
        _package.Length,
        _package.Manifest.Entries.Count);

    public static ArchiveSource Open(ArchiveSourceOptions options)
    {
        var path = ArchivePathResolver.Resolve(options);
        var package = ArchivePackageReader.Open(path, options.MaximumArchiveBytes);
        try
        {
            return new ArchiveSource(package);
        }
        catch
        {
            package.Dispose();
            throw;
        }
    }

    public AtlasSnapshotV1 GetCurrent() => _atlas with
    {
        Collection = new AtlasCollectionMetadataV1(
            AtlasCollectorMode.Archive,
            AtlasCollectorState.Ready,
            _atlas.Collection?.Sequence ?? 0,
            _atlas.Collection?.CollectedAt ?? _atlas.GeneratedAt,
            _atlas.Collection?.SourceTimestamp ?? _atlas.GeneratedAt,
            _atlas.Collection?.StaleAfter ?? _atlas.GeneratedAt,
            true,
            _atlas.Databases.Count,
            _atlas.Collection?.FailureCount ?? 0,
            _atlas.Collection?.SkipCount ?? 0,
            0,
            "ImportedArchive point-in-time evidence; no SQL Server connection or refresh is active.")
        {
            RowCount = _atlas.Collection?.RowCount ?? _atlas.Databases.Count,
        },
    };

    AtlasCollectorStatusV1 IAtlasCollectorStatusSource.GetStatus() => _atlasStatus with
    {
        Mode = AtlasCollectorMode.Archive,
        State = AtlasCollectorState.Ready,
        IsStale = true,
        NextAttemptAt = null,
        Reason = "ImportedArchive point-in-time evidence; no collector or retry loop is running.",
    };

    CapabilitiesSnapshotV1 ICapabilitiesSource.GetCurrent() => _capabilities;

    public LiveIncidentResponseV1 GetCurrentResponse()
    {
        if (_live.Snapshot is null)
            return _live with { Collector = StoppedCollector("Archive contains no live point-in-time sample.") };
        return _live with
        {
            Snapshot = _live.Snapshot with
            {
                Status = DataStatus.Stale,
                FreshUntil = _live.Snapshot.FreshUntil,
                Reason = $"ImportedArchive point-in-time sample observed at {_live.Snapshot.SourceTimestamp:O}; it is static and never live.",
            },
            Collector = StoppedCollector("ImportedArchive is static; no sampler, polling cycle, or SQL connection is running."),
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
        pageSize = Math.Clamp(pageSize, 1, 200);
        var key = $"{NormalizeMetric(metric)}|{databaseId ?? "*"}";
        if (!_queryStoreIndex.MetricPages.TryGetValue(key, out var series))
        {
            return Task.FromResult(new PageV1<QueryFamilySummaryV1>("1.0", [], null, pageSize, "0")
            {
                Evidence = ArchiveQueryEvidence("No matching Query Store family index is present in the archive."),
            });
        }
        var tokenScope = $"query:{key}";
        var offset = DecodeToken(
            pageToken,
            tokenScope,
            pageSize,
            () => new QueryStorePageTokenException("The archive page token is malformed or belongs to another query."));
        if (offset < 0 || offset > series.TotalCount)
            throw new QueryStorePageTokenException("The archive Query Store page token is invalid.");
        var items = ReadSeries<QueryFamilySummaryV1>(series, offset, pageSize, cancellationToken)
            .Select(_redactor.Redact)
            .Select(Import)
            .ToList();
        var nextOffset = offset + items.Count;
        return Task.FromResult(new PageV1<QueryFamilySummaryV1>(
            "1.0",
            items,
            nextOffset < series.TotalCount ? EncodeToken(nextOffset, tokenScope, pageSize) : null,
            pageSize,
            series.TotalCount.ToString(CultureInfo.InvariantCulture))
        {
            Evidence = items.Count == 0
                ? ArchiveQueryEvidence("Imported archive Query Store index.")
                : items[0].Evidence,
        });
    }

    public Task<QueryFamilyDetailV1?> GetFamilyAsync(string familyId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(_queryStoreIndex.FamilyEntries.TryGetValue(familyId, out var entry)
            ? Import(_redactor.Redact(ReadRequired<QueryFamilyDetailV1>(entry)))
            : null);
    }

    public Task<NormalizedShowplanV1?> GetPlanAsync(string planId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(_queryStoreIndex.PlanEntries.TryGetValue(planId, out var entry)
            ? Import(_redactor.Redact(ReadRequired<NormalizedShowplanV1>(entry)))
            : null);
    }

    public async Task<PlanComparisonV1?> ComparePlansAsync(
        string leftPlanId,
        string rightPlanId,
        CancellationToken cancellationToken)
    {
        var left = await GetPlanAsync(leftPlanId, cancellationToken).ConfigureAwait(false);
        var right = await GetPlanAsync(rightPlanId, cancellationToken).ConfigureAwait(false);
        return left is null || right is null ? null : PlanComparer.Compare(left, right);
    }

    public Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(_queryStoreStatus with
        {
            State = _queryStoreStatus.State == QueryStoreCollectorState.Disabled
                ? QueryStoreCollectorState.Disabled
                : QueryStoreCollectorState.Stale,
            NextAttemptAt = null,
            Reason = "ImportedArchive Query Store snapshot; no collection or refresh is active.",
        });
    }

    public ValueTask<DatabaseCitySummarySnapshotV1> GetSummariesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(_citySummaries);
    }

    public Task<DatabaseCityPageV1?> GetDatabaseAsync(
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize,
        string? pageToken,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (pageSize is < 1 or > 50)
            throw new DatabaseCityPageTokenException();
        if (!_cityIndex.Pages.TryGetValue(databaseId, out var metrics) ||
            !metrics.TryGetValue(metric.ToString(), out var series))
            return Task.FromResult<DatabaseCityPageV1?>(null);
        var tokenScope = $"city:{databaseId}:{metric}";
        var offset = DecodeToken(
            pageToken,
            tokenScope,
            pageSize,
            () => new DatabaseCityPageTokenException());
        if (offset < 0 || offset > series.TotalCount)
            throw new DatabaseCityPageTokenException();
        if (series.Entries.Count == 0)
            return Task.FromResult<DatabaseCityPageV1?>(null);
        var chunkIndex = series.TotalCount == 0 ? 0 : checked((int)(offset / series.ChunkSize));
        if (chunkIndex >= series.Entries.Count)
            return Task.FromResult<DatabaseCityPageV1?>(null);
        var archivedPages = ReadRequired<IReadOnlyList<DatabaseCityPageV1>>(series.Entries[chunkIndex]);
        if (archivedPages.Count != 1)
            throw new ArchiveValidationException("Archive database city chunk must contain exactly one page.");
        var page = Import(_redactor.Redact(archivedPages[0]));
        if (series.TotalCount == 0)
            return Task.FromResult<DatabaseCityPageV1?>(page with { PageSize = pageSize, NextPageToken = null });

        var objects = new List<DatabaseCityObjectV1>(pageSize);
        var contributingPages = new List<DatabaseCityPageV1>();
        var contributingChunks = new HashSet<int>();
        var currentOffset = offset;
        while (objects.Count < pageSize && currentOffset < series.TotalCount)
        {
            cancellationToken.ThrowIfCancellationRequested();
            chunkIndex = checked((int)(currentOffset / series.ChunkSize));
            var wrappers = ReadRequired<IReadOnlyList<DatabaseCityPageV1>>(series.Entries[chunkIndex]);
            if (wrappers.Count != 1)
                throw new ArchiveValidationException("Archive database city chunk must contain exactly one page.");
            var chunkPage = Import(_redactor.Redact(wrappers[0]));
            if (contributingChunks.Add(chunkIndex))
                contributingPages.Add(chunkPage);
            var withinChunk = checked((int)(currentOffset % series.ChunkSize));
            var take = Math.Min(pageSize - objects.Count, chunkPage.Objects.Count - withinChunk);
            if (take <= 0)
                throw new ArchiveValidationException("Archive database city index contains an inconsistent chunk.");
            objects.AddRange(chunkPage.Objects.Skip(withinChunk).Take(take));
            currentOffset += take;
        }
        var nextOffset = offset + objects.Count;
        var objectIds = objects.Select(item => item.ObjectId).ToHashSet(StringComparer.Ordinal);
        var schemaIds = objects.Select(item => item.SchemaId).ToHashSet(StringComparer.Ordinal);
        return Task.FromResult<DatabaseCityPageV1?>(page with
        {
            PageSize = pageSize,
            Objects = objects,
            Schemas = contributingPages
                .SelectMany(item => item.Schemas)
                .Where(schema => schemaIds.Contains(schema.SchemaId))
                .DistinctBy(schema => schema.SchemaId, StringComparer.Ordinal)
                .ToArray(),
            TopQueryFamilies = contributingPages
                .SelectMany(item => item.TopQueryFamilies)
                .Where(family => family.ObjectIds.Any(objectIds.Contains))
                .DistinctBy(family => family.FamilyId, StringComparer.Ordinal)
                .ToArray(),
            Routes = contributingPages
                .SelectMany(item => item.Routes)
                .Where(route => objectIds.Contains(route.FromObjectId))
                .DistinctBy(route => route.RouteId, StringComparer.Ordinal)
                .ToArray(),
            TotalObjects = series.TotalCount.ToString(CultureInfo.InvariantCulture),
            NextPageToken = nextOffset < series.TotalCount
                ? EncodeToken(nextOffset, tokenScope, pageSize)
                : null,
        });
    }

    public void Dispose() => _package.Dispose();

    private T ReadRequired<T>(string entry) => ArchiveJson.Deserialize<T>(_package.ReadEntry(entry));

    private T? ReadOptional<T>(string entry) where T : class =>
        _package.Manifest.Entries.Any(value => value.Name == entry)
            ? ReadRequired<T>(entry)
            : null;

    private List<T> ReadSeries<T>(
        ArchivePageSeries series,
        long offset,
        int count,
        CancellationToken cancellationToken)
    {
        if (series.ChunkSize < 1 || series.ChunkSize > 1000)
            throw new ArchiveValidationException("Archive page index has an invalid chunk size.");
        var output = new List<T>(count);
        var current = offset;
        while (output.Count < count && current < series.TotalCount)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var chunkIndex = checked((int)(current / series.ChunkSize));
            if (chunkIndex >= series.Entries.Count)
                throw new ArchiveValidationException("Archive page index is truncated.");
            var chunk = ReadRequired<IReadOnlyList<T>>(series.Entries[chunkIndex]);
            if (chunk.Count > series.ChunkSize)
                throw new ArchiveValidationException("Archive page chunk exceeds its declared bound.");
            var within = checked((int)(current % series.ChunkSize));
            var take = Math.Min(count - output.Count, chunk.Count - within);
            if (take <= 0)
                throw new ArchiveValidationException("Archive page index contains an inconsistent chunk.");
            output.AddRange(chunk.Skip(within).Take(take));
            current += take;
        }
        return output;
    }

    private AtlasSnapshotV1 Import(AtlasSnapshotV1 value) => value with
    {
        Target = value.Target with
        {
            TargetId = _package.Manifest.Target.OpaqueIdentity,
            DisplayName = _package.Manifest.Target.DisplayAlias,
        },
        Databases = value.Databases.Select(database => database with
        {
            Allocated = database.Allocated with { Evidence = Import(database.Allocated.Evidence) },
            Used = database.Used with { Evidence = Import(database.Used.Evidence) },
            LiveActivity = database.LiveActivity with { Evidence = Import(database.LiveActivity.Evidence) },
            QueryStore = database.QueryStore with { Evidence = Import(database.QueryStore.Evidence) },
            LogAllocated = database.LogAllocated is null
                ? null : database.LogAllocated with { Evidence = Import(database.LogAllocated.Evidence) },
            LogUsed = database.LogUsed is null
                ? null : database.LogUsed with { Evidence = Import(database.LogUsed.Evidence) },
            FileIo = database.FileIo is null
                ? null : database.FileIo with { Evidence = Import(database.FileIo.Evidence) },
        }).ToArray(),
        Edges = value.Edges.Select(edge => edge with { Evidence = Import(edge.Evidence) }).ToArray(),
    };

    private static EvidenceV1 Import(EvidenceV1 value) => value with
    {
        Source = EvidenceSource.ImportedArchive,
        Status = value.Status == DataStatus.Available ? DataStatus.Stale : value.Status,
        Reason = $"ImportedArchive: {value.Reason}",
    };

    private static QueryStoreEvidenceV1 Import(QueryStoreEvidenceV1 value) => value with
    {
        Source = QueryStoreSource.ImportedArchive,
        Status = value.Status == DataStatus.Available ? DataStatus.Stale : value.Status,
        Reason = $"ImportedArchive: {value.Reason}",
        Caveat = $"ImportedArchive is static. {value.Caveat}",
    };

    private static QueryFamilySummaryV1 Import(QueryFamilySummaryV1 value) => value with
    {
        Evidence = Import(value.Evidence),
    };

    private static QueryFamilyDetailV1 Import(QueryFamilyDetailV1 value) => value with
    {
        Family = Import(value.Family),
        Plans = value.Plans.Select(plan => plan with { Evidence = Import(plan.Evidence) }).ToArray(),
        Runtime = value.Runtime.Select(runtime => runtime with { Evidence = Import(runtime.Evidence) }).ToArray(),
    };

    private static NormalizedShowplanV1 Import(NormalizedShowplanV1 value) => value with
    {
        Evidence = Import(value.Evidence),
        RuntimeOverlayCaveat = $"ImportedArchive is static. {value.RuntimeOverlayCaveat}",
    };

    private static DatabaseCitySummarySnapshotV1 Import(DatabaseCitySummarySnapshotV1 value) => value with
    {
        Databases = value.Databases.Select(database => database with
        {
            Evidence = Import(database.Evidence),
        }).ToArray(),
    };

    private static DatabaseCityPageV1 Import(DatabaseCityPageV1 value) => value with
    {
        Evidence = Import(value.Evidence),
        Schemas = value.Schemas.Select(schema => schema with { Evidence = Import(schema.Evidence) }).ToArray(),
        Objects = value.Objects.Select(item => item with
        {
            DirectActivity = item.DirectActivity with { Evidence = Import(item.DirectActivity.Evidence) },
            AttributedExposure = item.AttributedExposure with { Evidence = Import(item.AttributedExposure.Evidence) },
            Indexes = item.Indexes.Select(index => index with
            {
                DirectActivity = index.DirectActivity with { Evidence = Import(index.DirectActivity.Evidence) },
            }).ToArray(),
        }).ToArray(),
        TopQueryFamilies = value.TopQueryFamilies.Select(family => family with
        {
            Evidence = Import(family.Evidence),
        }).ToArray(),
        OtherWorkload = value.OtherWorkload with { Evidence = Import(value.OtherWorkload.Evidence) },
        Routes = value.Routes.Select(route => route with { Evidence = Import(route.Evidence) }).ToArray(),
    };

    private CapabilitiesSnapshotV1 Import(
        CapabilitiesSnapshotV1 value,
        string archivedAtlasTargetId)
    {
        var matchingTargets = value.Targets.Count(target =>
            string.Equals(target.TargetId, archivedAtlasTargetId, StringComparison.Ordinal));
        if (value.Targets.Count > 0 && matchingTargets != 1)
            throw new ArchiveValidationException(
                "Archive capabilities do not identify exactly one atlas target.");
        return value with
        {
            Targets = value.Targets.Select(target =>
            {
                var imported = Import(target);
                return imported with
                {
                    TargetId = string.Equals(target.TargetId, archivedAtlasTargetId, StringComparison.Ordinal)
                        ? _package.Manifest.Target.OpaqueIdentity
                        : imported.TargetId,
                };
            }).ToArray(),
        };
    }

    private static TargetCapabilityProfileV1 Import(TargetCapabilityProfileV1 value) => value with
    {
        Platform = value.Platform with { Evidence = Import(value.Platform.Evidence) },
        Databases = value.Databases.Select(database => database with
        {
            Evidence = Import(database.Evidence),
        }).ToArray(),
        DatabaseDiscovery = value.DatabaseDiscovery with { Evidence = Import(value.DatabaseDiscovery.Evidence) },
        ServerVisibility = value.ServerVisibility with { Evidence = Import(value.ServerVisibility.Evidence) },
        Waits = value.Waits with { Evidence = Import(value.Waits.Evidence) },
        LiveSessions = value.LiveSessions with { Evidence = Import(value.LiveSessions.Evidence) },
        PlansAndText = value.PlansAndText with { Evidence = Import(value.PlansAndText.Evidence) },
        ParameterSensitivePlan = value.ParameterSensitivePlan with { Evidence = Import(value.ParameterSensitivePlan.Evidence) },
        OptionalParameterPlanOptimization = value.OptionalParameterPlanOptimization with
        {
            Evidence = Import(value.OptionalParameterPlanOptimization.Evidence),
        },
        ReadableSecondaryQueryStore = value.ReadableSecondaryQueryStore with
        {
            Evidence = Import(value.ReadableSecondaryQueryStore.Evidence),
        },
        QueryStoreByDatabase = value.QueryStoreByDatabase.ToDictionary(
            pair => pair.Key,
            pair => pair.Value with { Evidence = Import(pair.Value.Evidence) },
            StringComparer.Ordinal),
        AzureResourceMetrics = value.AzureResourceMetrics with { Evidence = Import(value.AzureResourceMetrics.Evidence) },
    };

    private static CapabilityEvidenceV1 Import(CapabilityEvidenceV1 value) => value with
    {
        Reason = $"ImportedArchive: {value.Reason}",
    };

    private LiveIncidentResponseV1 Import(LiveIncidentResponseV1 value)
    {
        if (value.Snapshot is null)
            return value;
        return value with
        {
            Snapshot = value.Snapshot with
            {
                Target = value.Snapshot.Target with
                {
                    TargetId = _package.Manifest.Target.OpaqueIdentity,
                    DisplayName = _package.Manifest.Target.DisplayAlias,
                },
                Status = DataStatus.Stale,
                Reason = $"ImportedArchive: {value.Snapshot.Reason}",
            },
        };
    }

    private void ValidateIndexes()
    {
        RequireSection(AtlasSnapshotEntry, "atlas");
        RequireOptionalSection(AtlasStatusEntry, "atlas");
        RequireOptionalSection(CapabilitiesEntry, "capabilities");
        RequireOptionalSection(LiveResponseEntry, "live");
        RequireOptionalSection(QueryStoreStatusEntry, "query-store");
        RequireOptionalSection(QueryStoreIndexEntry, "query-store");
        RequireOptionalSection(CitySummariesEntry, "database-city");
        RequireOptionalSection(CityIndexEntry, "database-city");

        ValidateIndexMap(_queryStoreIndex.FamilyEntries, "Query Store family");
        ValidateIndexMap(_queryStoreIndex.PlanEntries, "Query Store plan");
        foreach (var (familyId, entry) in _queryStoreIndex.FamilyEntries)
        {
            var family = _redactor.Redact(ReadRequired<QueryFamilyDetailV1>(entry));
            if (!string.Equals(family.Family.FamilyId, familyId, StringComparison.Ordinal))
                throw new ArchiveValidationException($"Archive family index key '{familyId}' does not match its payload.");
        }
        foreach (var (planId, entry) in _queryStoreIndex.PlanEntries)
        {
            var plan = _redactor.Redact(ReadRequired<NormalizedShowplanV1>(entry));
            if (!string.Equals(plan.PlanId, planId, StringComparison.Ordinal))
                throw new ArchiveValidationException($"Archive plan index key '{planId}' does not match its payload.");
        }
        foreach (var (key, series) in _queryStoreIndex.MetricPages)
        {
            ValidateIndexKey(key, "Query Store metric");
            var parts = key.Split('|');
            if (parts.Length != 2 ||
                parts[0] is not ("cpu" or "executions" or "duration" or "reads" or "waits") ||
                string.IsNullOrWhiteSpace(parts[1]))
                throw new ArchiveValidationException($"Archive Query Store metric key '{key}' is invalid.");
            ValidateSeries<QueryFamilySummaryV1>(
                series,
                "query-store",
                _ => 1,
                validateItem: family =>
                {
                    var imported = _redactor.Redact(family);
                    if (parts[1] != "*" &&
                        !string.Equals(imported.DatabaseId, parts[1], StringComparison.Ordinal))
                        throw new ArchiveValidationException(
                            $"Archive Query Store metric key '{key}' does not match a payload database.");
                });
        }
        foreach (var (databaseId, metrics) in _cityIndex.Pages)
        {
            ValidateIndexKey(databaseId, "database city database");
            if (metrics.Count > 16)
                throw new ArchiveValidationException("Archive database city index has too many metrics.");
            foreach (var (metric, series) in metrics)
            {
                if (!Enum.TryParse<DatabaseCityMetric>(metric, out var parsedMetric))
                    throw new ArchiveValidationException($"Archive database city metric '{metric}' is invalid.");
                ValidateSeries<DatabaseCityPageV1>(
                    series,
                    "database-city",
                    page => page.Objects.Count,
                    pageWrappers: true,
                    validateItem: page =>
                    {
                        var imported = _redactor.Redact(page);
                        if (!string.Equals(imported.DatabaseId, databaseId, StringComparison.Ordinal) ||
                            imported.Metric != parsedMetric)
                            throw new ArchiveValidationException(
                                $"Archive database city key '{databaseId}|{metric}' does not match its payload.");
                    });
            }
        }
    }

    private void ValidateIndexMap(IReadOnlyDictionary<string, string> values, string kind)
    {
        if (values.Count > ArchiveFormat.MaxEntryCount)
            throw new ArchiveValidationException($"Archive {kind} index is oversized.");
        foreach (var (key, entry) in values)
        {
            ValidateIndexKey(key, kind);
            RequireSection(entry, "query-store");
        }
    }

    private static void ValidateIndexKey(string value, string kind)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > ArchiveFormat.MaxJsonStringBytes)
            throw new ArchiveValidationException($"Archive {kind} index key is invalid.");
    }

    private void ValidateSeries<T>(
        ArchivePageSeries series,
        string section,
        Func<T, long> entryRecordCount,
        bool pageWrappers = false,
        Action<T>? validateItem = null)
    {
        if (series.ChunkSize is < 1 or > 1000 ||
            series.TotalCount is < 0 or > ArchiveFormat.MaxRecords ||
            series.Entries.Count > ArchiveFormat.MaxEntryCount ||
            series.Entries.Distinct(StringComparer.Ordinal).Count() != series.Entries.Count)
            throw new ArchiveValidationException("Archive page series bounds are invalid.");
        var expectedEntries = series.TotalCount == 0
            ? pageWrappers && series.Entries.Count == 1 ? 1 : 0
            : checked((int)((series.TotalCount + series.ChunkSize - 1) / series.ChunkSize));
        if (series.Entries.Count != expectedEntries)
            throw new ArchiveValidationException("Archive page series entry count is inconsistent.");
        long records = 0;
        for (var index = 0; index < series.Entries.Count; index++)
        {
            var name = series.Entries[index];
            var entry = RequireSection(name, section);
            var chunk = ReadRequired<IReadOnlyList<T>>(name);
            foreach (var item in chunk)
                validateItem?.Invoke(item);
            var chunkRecords = chunk.Sum(entryRecordCount);
            var expectedChunkRecords = series.TotalCount == 0
                ? 0
                : Math.Min(
                    series.ChunkSize,
                    series.TotalCount - (long)index * series.ChunkSize);
            if (chunk.Count < 1 ||
                (!pageWrappers && chunk.Count > series.ChunkSize) ||
                (pageWrappers && (chunk.Count != 1 || chunkRecords > series.ChunkSize)) ||
                chunkRecords != expectedChunkRecords ||
                entry.RecordCount != chunkRecords)
                throw new ArchiveValidationException($"Archive page chunk '{name}' has an inconsistent count.");
            records = checked(records + chunkRecords);
        }
        if (records != series.TotalCount)
            throw new ArchiveValidationException("Archive page series total is inconsistent.");
    }

    private ArchiveEntry RequireSection(string name, string section)
    {
        var entry = _package.Manifest.Entries.FirstOrDefault(value => value.Name == name)
            ?? throw new ArchiveValidationException($"Archive index references missing entry '{name}'.");
        if (entry.Section != section)
            throw new ArchiveValidationException($"Archive entry '{name}' is in the wrong section.");
        return entry;
    }

    private void RequireOptionalSection(string name, string section)
    {
        if (_package.Manifest.Entries.Any(value => value.Name == name))
            RequireSection(name, section);
    }

    private static void RequireFeatures(ArchiveManifest manifest)
    {
        var known = new HashSet<string>(StringComparer.Ordinal)
        {
            "atlas-v1", "capabilities-v1", "query-store-v1", "database-city-v1",
            "live-point-in-time-v1", LegacyFindingsFeature, "canonical-json-v1",
            "uncompressed-container-v1",
        };
        var unsupported = manifest.Features.Where(feature => !known.Contains(feature)).ToArray();
        if (unsupported.Length > 0)
            throw new ArchiveValidationException($"Archive requires unsupported features: {string.Join(", ", unsupported)}.");
    }

    private static LiveCollectorStatusV1 StoppedCollector(string reason) =>
        new(SamplerRunState.Stopped, 0, null, null, 0, null, reason, 0, 0);

    private static QueryStoreEvidenceV1 ArchiveQueryEvidence(string reason) =>
        new(QueryStoreSource.ImportedArchive, DataStatus.Stale, null, null, reason,
            "ImportedArchive aggregate history; no live SQL Server connection is active.");

    private static string NormalizeMetric(string value) => value.ToLowerInvariant() switch
    {
        "execution" or "executions" => "executions",
        "duration" => "duration",
        "reads" => "reads",
        "waits" => "waits",
        _ => "cpu",
    };

    private static long DecodeToken(
        string? token,
        string scope,
        int pageSize,
        Func<Exception> invalidToken)
    {
        if (token is null)
            return 0;
        if (token.Length > 256)
            throw invalidToken();
        try
        {
            var text = Encoding.UTF8.GetString(Convert.FromBase64String(token));
            var parts = text.Split(':');
            var expectedScope = TokenScope(scope);
            return parts.Length == 3 &&
                   long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var value) &&
                   value >= 0 &&
                   int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var encodedPageSize) &&
                   encodedPageSize == pageSize &&
                   CryptographicOperations.FixedTimeEquals(
                       Encoding.ASCII.GetBytes(parts[2]),
                       Encoding.ASCII.GetBytes(expectedScope))
                ? value
                : throw new FormatException();
        }
        catch (FormatException)
        {
            throw invalidToken();
        }
    }

    private static string EncodeToken(long offset, string scope, int pageSize) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(
            $"{offset.ToString(CultureInfo.InvariantCulture)}:{pageSize.ToString(CultureInfo.InvariantCulture)}:{TokenScope(scope)}"));

    private static string TokenScope(string scope) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(scope)).AsSpan(0, 8));
}
