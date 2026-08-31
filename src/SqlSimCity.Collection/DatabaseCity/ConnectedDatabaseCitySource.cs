using System.Globalization;
using System.Numerics;
using System.Text;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.DatabaseCity;

public sealed class ConnectedDatabaseCitySource(
    IAtlasSnapshotSource atlasSource,
    IDatabaseCityProbeExecutor probeExecutor,
    QueryStoreCityAttribution? attribution = null,
    int? topQueryFamilyCount = null) : IDatabaseCitySource
{
    /// <summary>
    /// How many query families this source asks for per page.
    /// <para>
    /// Configurable because the right number is a property of the instance being watched, not of
    /// this code: a database with forty retained families wants all of them, and one with forty
    /// thousand wants a bound. The default is <see
    /// cref="QueryStoreCityAttribution.DefaultTopFamilyCount"/>.
    /// </para>
    /// <para>
    /// Out-of-range configuration is clamped rather than rejected. Attribution treats a count
    /// outside its supported range as a programming error and throws, which reaches the endpoint as
    /// a 500 -- so passing a configured value straight through would let one mistyped setting take
    /// the city page down with an error that names neither the setting nor the limit. A non-positive
    /// value is ignored rather than treated as "no families", because a page with no families is
    /// indistinguishable from a database Query Store never captured and is never what an operator
    /// meant.
    /// </para>
    /// </summary>
    private readonly int topFamilyCount = topQueryFamilyCount is > 0
        ? Math.Min(topQueryFamilyCount.Value, QueryStoreCityAttribution.MaxTopFamilyCount)
        : QueryStoreCityAttribution.DefaultTopFamilyCount;

    public ValueTask<DatabaseCitySummarySnapshotV1> GetSummariesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var atlas = atlasSource.GetCurrent();
        var summaries = atlas.Databases
            .OrderBy(database => database.DatabaseId, StringComparer.Ordinal)
            .Select(database =>
            {
                const string reason =
                    "Object counts are collected only when this database is entered; database size comes from the atlas.";
                return new DatabaseCitySummaryV1(
                    database.DatabaseId,
                    database.Name,
                    null,
                    null,
                    null,
                    MeasurementStatus.Unknown,
                    new EvidenceV1(EvidenceSource.NotProbed, DataStatus.Unknown, atlas.GeneratedAt, null, reason));
            })
            .ToArray();
        return ValueTask.FromResult(new DatabaseCitySummarySnapshotV1("1.0", atlas.GeneratedAt, summaries));
    }

    public async Task<DatabaseCityPageV1?> GetDatabaseAsync(
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize,
        string? pageToken,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (pageSize is < 1 or > 50)
            throw new ArgumentOutOfRangeException(nameof(pageSize));
        var atlas = atlasSource.GetCurrent();
        var database = atlas.Databases.SingleOrDefault(
            item => item.DatabaseId.Equals(databaseId, StringComparison.Ordinal));
        if (database is null)
            return null;
        var cursor = DecodeToken(pageToken, databaseId, metric, pageSize);

        DatabaseCityProbePage probe;
        try
        {
            probe = await probeExecutor.CollectPageAsync(
                database.Name, cursor.AfterObjectId, pageSize + 1, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (ProbeExecutionException ex)
        {
            return UnavailablePage(database, metric, pageSize, Status(ex), ex.Reason);
        }

        var groups = probe.Inventory
            .GroupBy(row => row.ObjectId)
            .OrderBy(group => group.Key)
            .ToArray();
        var selectedGroups = groups.Take(pageSize).ToArray();
        var usageByIndex = probe.Usage.ToDictionary(
            row => (row.ObjectId, row.IndexId),
            row => row.TotalOperations);
        var statisticsByObject = (probe.Statistics ?? []).ToDictionary(row => row.ObjectId);
        var directEvidence = new EvidenceV1(
            EvidenceSource.LiveDmvCumulative,
            probe.UsageStatus,
            probe.ObservedAt,
            null,
            probe.UsageReason);
        var unavailableAttribution = new EvidenceV1(
            EvidenceSource.NotProbed,
            DataStatus.Unknown,
            null,
            null,
            "Normalized plan attribution is unavailable for this bounded connected page.");
        var attributionObjects = selectedGroups
            .Select(group => group.First())
            .Select(row => new CityAttributionObject(
                ObjectId(databaseId, row.ObjectId), row.SchemaName, row.ObjectName, row.Kind))
            .ToArray();
        // Query Store history is collected and indexed per database name, so the join is filtered by
        // the name, never by the atlas contract id this page is addressed by: an atlas id matches no
        // published Query Store index and would leave every object on the page unattributed.
        var joined = attribution is null
            ? null
            : await attribution.AttributeAsync(
                database.Name,
                metric,
                attributionObjects,
                DatabaseIdsByName(atlas),
                topFamilyCount,
                cancellationToken).ConfigureAwait(false);
        var familyIdsByObject = (joined?.Families ?? [])
            .SelectMany(family => family.ObjectIds.Select(objectId => (objectId, family.FamilyId)))
            .ToLookup(pair => pair.objectId, pair => pair.FamilyId, StringComparer.Ordinal);

        /*
         * Null means nobody measured this object's statistics, and is deliberately distinct from a
         * row saying it has none. When the probe was denied or unsupported there is no evidence at
         * all, so returning a zeroed row would let a caller read "no stale statistics" out of "we
         * never looked" -- the same conflation the deadlock evidence already guards against.
         */
        DatabaseCityStatisticsAgeV1? StatisticsFor(int rawObjectId)
        {
            if (probe.StatisticsStatus != DataStatus.Available)
            {
                return probe.StatisticsReason is null
                    ? null
                    : new DatabaseCityStatisticsAgeV1(
                        null, 0, 0, 0, null, MeasurementStatus.Unknown, probe.StatisticsReason);
            }

            // The probe returns no row for an object that carries no non-hypothetical statistic.
            // That is a measured zero, not missing evidence, so it is Known with an empty count.
            if (!statisticsByObject.TryGetValue(rawObjectId, out var row))
            {
                return new DatabaseCityStatisticsAgeV1(
                    null, 0, 0, 0, null, MeasurementStatus.Known,
                    "This object carries no non-hypothetical statistics.", 0);
            }

            return new DatabaseCityStatisticsAgeV1(
                row.OldestLastUpdated,
                row.StatisticsCount,
                row.NeverUpdatedCount,
                row.UnreadableCount,
                row.ModificationCounter,
                MeasurementStatus.Known,
                row.UnreadableCount > 0
                    ? $"{row.UnreadableCount.ToString(CultureInfo.InvariantCulture)} of {row.StatisticsCount.ToString(CultureInfo.InvariantCulture)} statistics could not be read and are excluded from the age."
                    : null,
                row.PastAutoUpdateThresholdCount);
        }
        var schemas = selectedGroups
            .Select(group => group.First())
            .GroupBy(row => row.SchemaId)
            .Select(group =>
            {
                var row = group.First();
                return new DatabaseCitySchemaEvidence(
                    $"{databaseId}/schema/{row.SchemaId.ToString(CultureInfo.InvariantCulture)}",
                    row.SchemaName,
                    row.SchemaLayoutOrdinal);
            })
            .ToArray();
        var schemaIdsByContractId = selectedGroups
            .Select(group => group.First())
            .DistinctBy(row => row.SchemaId)
            .ToDictionary(
                row => $"{databaseId}/schema/{row.SchemaId.ToString(CultureInfo.InvariantCulture)}",
                row => row.SchemaId,
                StringComparer.Ordinal);
        var evidenceObjects = selectedGroups.Select((group, pageOrdinal) =>
        {
            var first = group.First();
            var objectId = ObjectId(databaseId, first.ObjectId);
            var indexes = group
                .Where(row => row.IndexId is not null)
                .OrderBy(row => row.IndexId)
                .Select(row =>
                {
                    var indexId = row.IndexId ??
                        throw new InvalidOperationException("An attached index row must have an index ID.");
                    var indexKind = row.IndexKind ??
                        throw new InvalidOperationException("An attached index row must have an index kind.");
                    var operations = probe.UsageStatus == DataStatus.Available
                        ? usageByIndex.GetValueOrDefault((row.ObjectId, indexId), "0")
                        : null;
                    return new DatabaseCityIndexV1(
                        $"{objectId}/index/{indexId.ToString(CultureInfo.InvariantCulture)}",
                        row.IndexName ?? "HEAP",
                        indexKind,
                        new DatabaseCityDirectActivityV1(
                            operations,
                            null,
                            directEvidence));
                })
                .ToArray();
            var totalOperations = probe.UsageStatus == DataStatus.Available
                ? indexes.Aggregate(BigInteger.Zero, (sum, index) =>
                    sum + BigInteger.Parse(
                        index.DirectActivity.TotalOperations!, NumberStyles.None, CultureInfo.InvariantCulture))
                    .ToString(CultureInfo.InvariantCulture)
                : null;
            return new DatabaseCityObjectEvidence(
                objectId,
                $"{databaseId}/schema/{first.SchemaId.ToString(CultureInfo.InvariantCulture)}",
                first.ObjectName,
                first.Kind,
                first.ReservedPages8KiB,
                first.UsedPages8KiB,
                indexes,
                [.. familyIdsByObject[objectId]])
            {
                SizeReason = first.ReservedPages8KiB is null || first.UsedPages8KiB is null
                    ? "Current catalog partition page counts are unavailable; geometry is nonquantitative."
                    : null,
                LayoutOrdinal = cursor.LayoutOffset + pageOrdinal,
                DirectActivity = new DatabaseCityDirectActivityV1(
                    totalOperations,
                    null,
                    directEvidence),
                AttributedExposure = Exposure(joined, objectId, unavailableAttribution),
                Statistics = StatisticsFor(first.ObjectId),
            };
        }).ToArray();
        var projected = DatabaseCityProjector.ProjectObjects(schemas, evidenceObjects);        var nextToken = groups.Length > pageSize && selectedGroups.Length > 0
            ? EncodeToken(
                databaseId, metric, pageSize, selectedGroups[^1].Key,
                cursor.LayoutOffset + selectedGroups.Length)
            : null;
        var schemaContracts = schemas
            .OrderBy(schema => schema.SchemaId, StringComparer.Ordinal)
            .Select(schema => new DatabaseCitySchemaV1(
                schema.SchemaId,
                schema.Name,
                schema.LayoutOrdinal ?? 0,
                selectedGroups.Count(group =>
                        group.First().SchemaId == schemaIdsByContractId[schema.SchemaId])
                    .ToString(CultureInfo.InvariantCulture),
                new EvidenceV1(
                    EvidenceSource.CatalogSnapshot, DataStatus.Available, probe.ObservedAt, null,
                    "Schema neighborhood from the bounded current-database catalog page.")))
            .ToArray();
        var workloadEvidence = new EvidenceV1(
            EvidenceSource.NotProbed, DataStatus.Unknown, null, null,
            "Other workload is unavailable because no Query Store history source is wired into this page.");
        var pageEvidence = new EvidenceV1(
            EvidenceSource.CatalogSnapshot, DataStatus.Available, probe.ObservedAt, null,
            "Static keyset-bounded catalog SELECT; parent objects were bounded before attached-index expansion.");

        return new DatabaseCityPageV1(
            "1.0",
            databaseId,
            database.Name,
            metric,
            pageSize,
            nextToken,
            probe.TotalObjects,
            schemaContracts,
            projected,
            [.. (joined?.Families ?? []).Select(family => ToContract(family, joined!.Evidence))],
            joined?.OtherWorkload ??
                new DatabaseCityWorkloadAggregateV1(null, null, null, null, null, null, workloadEvidence),
            joined?.Routes ?? [],
            pageEvidence);
    }

    private static DatabaseCityQueryFamilyV1 ToContract(
        DatabaseCityQueryEvidence family,
        EvidenceV1 evidence) => new(
        family.FamilyId,
        family.QueryHash,
        family.ExecutionCount,
        family.TotalCpuMicroseconds,
        family.TotalDurationMicroseconds,
        family.TotalLogicalReads8KiBPages,
        family.TotalWaitMilliseconds,
        family.WaitMillisecondsByCategory,
        family.ObjectIds,
        family.Confidence,
        family.Rationale,
        evidence)
    {
        WaitAttribution = family.WaitAttribution,
        PlanDataVolume = family.PlanDataVolume,
        RecentActivity = family.RecentActivity,
    };

    /// <summary>
    /// The attribution join publishes an entry for every on-page object a ranked family named, so
    /// this fallback fires only when none did. Saying so is then accurate, rather than a guess about
    /// which of two very different silences the reader is looking at.
    /// </summary>
    private static DatabaseCityAttributedExposureV1 Exposure(
        CityAttributionResult? joined,
        string objectId,
        EvidenceV1 unavailable)
    {
        if (joined is null)
        {
            return new DatabaseCityAttributedExposureV1(
                null, null, null, null, QueryAttributionConfidence.Unknown,
                "No normalized plan evidence was joined; query totals are not assigned to this object.",
                unavailable);
        }

        if (joined.ExposureByObjectId.TryGetValue(objectId, out var exposure))
            return exposure;
        return new DatabaseCityAttributedExposureV1(
            null, null, null, null, QueryAttributionConfidence.Unknown,
            "No ranked Query Store family names this object at all, alone or alongside others, so no query totals are attributed to it; this is absent evidence, not measured zero.",
            joined.Evidence);
    }

    /// <summary>
    /// Maps database names to atlas identities so a three-part plan reference can name a real
    /// neighbouring city. Ambiguous names are dropped rather than resolved arbitrarily.
    /// </summary>
    private static Dictionary<string, string> DatabaseIdsByName(AtlasSnapshotV1 atlas) =>
        atlas.Databases
            .GroupBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
            .Where(group => group.Count() == 1)
            .ToDictionary(group => group.Key, group => group.First().DatabaseId, StringComparer.OrdinalIgnoreCase);

    private static DatabaseCityPageV1 UnavailablePage(
        DatabaseAtlasItemV1 database,
        DatabaseCityMetric metric,
        int pageSize,
        DataStatus status,
        string reason)
    {
        var evidence = new EvidenceV1(EvidenceSource.CatalogSnapshot, status, null, null, reason);
        return new DatabaseCityPageV1(
            "1.0", database.DatabaseId, database.Name, metric, pageSize, null, null,
            [], [], [], new DatabaseCityWorkloadAggregateV1(null, null, null, null, null, null, evidence),
            [], evidence);
    }

    private static DataStatus Status(ProbeExecutionException exception) => exception switch
    {
        ProbePermissionDeniedException => DataStatus.PermissionDenied,
        ProbeObjectUnavailableException or ProbeNotProbedException => DataStatus.Unsupported,
        ProbeTransientConnectionException or ProbeDatabaseUnavailableException or ProbeAuthenticationException =>
            DataStatus.Disconnected,
        _ => DataStatus.Unknown,
    };

    private static string ObjectId(string databaseId, int objectId) =>
        $"{databaseId}/object/{objectId.ToString(CultureInfo.InvariantCulture)}";

    private static string EncodeToken(
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize,
        int afterObjectId,
        int layoutOffset)
    {
        var bytes = Encoding.UTF8.GetBytes(
            $"1|{databaseId}|{metric}|{pageSize.ToString(CultureInfo.InvariantCulture)}|{afterObjectId.ToString(CultureInfo.InvariantCulture)}|{layoutOffset.ToString(CultureInfo.InvariantCulture)}");
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static DatabaseCityCursor DecodeToken(
        string? token,
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize)
    {
        if (token is null)
            return new DatabaseCityCursor(0, 0);
        if (token.Length is < 1 or > 1024 || token.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_')))
            throw new DatabaseCityPageTokenException();
        try
        {
            var base64 = token.Replace('-', '+').Replace('_', '/');
            base64 = base64.PadRight((base64.Length + 3) / 4 * 4, '=');
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(base64)).Split('|');
            if (parts.Length != 6 ||
                parts[0] != "1" ||
                parts[1] != databaseId ||
                parts[2] != metric.ToString() ||
                !int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out var tokenPageSize) ||
                tokenPageSize != pageSize ||
                !int.TryParse(parts[4], NumberStyles.None, CultureInfo.InvariantCulture, out var afterObjectId) ||
                afterObjectId < 0 ||
                !int.TryParse(parts[5], NumberStyles.None, CultureInfo.InvariantCulture, out var layoutOffset) ||
                layoutOffset < 0)
                throw new DatabaseCityPageTokenException();
            return new DatabaseCityCursor(afterObjectId, layoutOffset);
        }
        catch (FormatException)
        {
            throw new DatabaseCityPageTokenException();
        }
        catch (DecoderFallbackException)
        {
            throw new DatabaseCityPageTokenException();
        }
    }

    private sealed record DatabaseCityCursor(int AfterObjectId, int LayoutOffset);
}
