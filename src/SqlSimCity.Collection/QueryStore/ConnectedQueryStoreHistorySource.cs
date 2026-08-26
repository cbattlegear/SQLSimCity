using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.Json;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Storage;

namespace SqlSimCity.Collection.QueryStore;

public sealed class ConnectedQueryStoreHistorySource(
    ProtectedQueryStoreRepository repository,
    IQueryStoreIncrementalSource incrementalSource,
    SecureShowplanParser showplanParser,
    QueryStoreCollectionStatusTracker statusTracker,
    TimeProvider timeProvider,
    bool allowRawPayloadHydration = true) : IQueryStoreHistorySource
{
    public Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(
        string? databaseId,
        string metric,
        int pageSize,
        string? pageToken,
        CancellationToken cancellationToken) =>
        repository.ReadConsistentPublishedSnapshotAsync(
            (reader, snapshot, token) => GetQueriesAsync(
                reader, snapshot, databaseId, metric, pageSize, pageToken, token),
            cancellationToken);

    private static async Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(
        ProtectedQueryStoreRepository reader,
        QueryStorePublishedSnapshot? snapshot,
        string? databaseId,
        string metric,
        int pageSize,
        string? pageToken,
        CancellationToken cancellationToken)
    {
        if (snapshot is null)
            return Empty(pageSize, "No complete connected Query Store snapshot has been published yet.");

        var cursor = DecodeToken(pageToken);
        if (cursor is not null &&
            (!string.Equals(cursor.SnapshotId, snapshot.SnapshotId, StringComparison.Ordinal) ||
             !string.Equals(cursor.Metric, metric, StringComparison.Ordinal) ||
             !string.Equals(cursor.DatabaseId, databaseId, StringComparison.Ordinal)))
            throw new QueryStorePageTokenException("The Query Store page token is stale or belongs to another filter.");

        if (snapshot.IndexSets is null)
            return await GetLegacyQueriesAsync(
                reader, snapshot, databaseId, metric, pageSize, cursor, cancellationToken).ConfigureAwait(false);

        var index = ResolveIndexSet(snapshot.IndexSets, NormalizeMetric(metric), databaseId);
        if (index is null) return Empty(pageSize, "No Query Store families match this database filter.");
        var pageIndex = cursor?.PageIndex ?? 0;
        var offset = cursor?.Offset ?? 0;
        if (offset is < 0 or >= 200 ||
            cursor is not null && pageIndex >= index.PageCount)
            throw new QueryStorePageTokenException("The Query Store page token is outside the published index.");
        var families = new List<QueryFamilySummaryV1>(pageSize);
        while (families.Count < pageSize && pageIndex < index.PageCount)
        {
            var indexPage = await reader.ReadIndexPageAsync(
                snapshot, index.Metric, index.DatabaseId, pageIndex, cancellationToken)
                .ConfigureAwait(false) ?? throw new InvalidDataException("A protected Query Store index page is missing.");
            if (cursor is not null && families.Count == 0 && offset >= indexPage.FamilyIds.Count)
                throw new QueryStorePageTokenException("The Query Store page token is outside the published index.");
            while (families.Count < pageSize && offset < indexPage.FamilyIds.Count)
            {
                var summary = await reader.ReadFamilySummaryAsync(
                    snapshot, indexPage.FamilyIds[offset++], cancellationToken)
                    .ConfigureAwait(false) ?? throw new InvalidDataException("A protected Query Store family is missing.");
                families.Add(summary);
            }
            if (offset >= indexPage.FamilyIds.Count) { pageIndex++; offset = 0; }
        }
        var hasMore = pageIndex < index.PageCount;
        var next = hasMore
            ? EncodeToken(new QueryPageCursor(snapshot.SnapshotId, metric, databaseId, pageIndex, offset))
            : null;
        return new PageV1<QueryFamilySummaryV1>(
            "1.0", families, next, pageSize,
            index.TotalCount.ToString(CultureInfo.InvariantCulture))
        {
            Evidence = (families.Count > 0 ? families[0].Evidence : null) ??
                ConnectedEvidence(snapshot.PublishedAt, snapshot.Status.State),
        };
    }

    public Task<QueryFamilyDetailV1?> GetFamilyAsync(
        string familyId,
        CancellationToken cancellationToken) =>
        repository.ReadConsistentPublishedSnapshotAsync(
            (reader, snapshot, token) => GetFamilyAsync(reader, snapshot, familyId, token),
            cancellationToken);

    /// <summary>
    /// Finds the published index set for one metric and database filter. A database name that
    /// differs only in case still resolves, because SQL Server database names are case-insensitive
    /// and the collected key can come from configuration rather than from the server. An ambiguous
    /// case-insensitive match resolves to nothing rather than to a guess.
    /// </summary>
    private static QueryStoreIndexSet? ResolveIndexSet(
        IReadOnlyList<QueryStoreIndexSet>? indexSets,
        string metric,
        string? databaseId)
    {
        if (indexSets is null) return null;
        var exact = indexSets.SingleOrDefault(item =>
            item.Metric == metric && item.DatabaseId == databaseId);
        if (exact is not null || databaseId is null) return exact;
        var insensitive = indexSets
            .Where(item => item.Metric == metric &&
                string.Equals(item.DatabaseId, databaseId, StringComparison.OrdinalIgnoreCase))
            .ToArray();
        return insensitive.Length == 1 ? insensitive[0] : null;
    }

    private async Task<QueryFamilyDetailV1?> GetFamilyAsync(
        ProtectedQueryStoreRepository reader,
        QueryStorePublishedSnapshot? snapshot,
        string familyId,
        CancellationToken cancellationToken)
    {
        QueryFamilyDetailV1? detail = null;
        if (snapshot is not null)
        {
            detail = snapshot.IndexSets is null
                ? (await reader.ReadPublishedSnapshotAsync(snapshot, cancellationToken).ConfigureAwait(false))
                    .Families.SingleOrDefault(item => item.Family.FamilyId == familyId)
                : await reader.ReadFamilyAsync(
                    snapshot, familyId, cancellationToken).ConfigureAwait(false);
        }
        if (detail is null) return null;
        var physical = new List<PhysicalQueryIdentityV1>(detail.Family.PhysicalQueries.Count);
        foreach (var identity in detail.Family.PhysicalQueries)
        {
            var descriptor = identity.Text;
            if (descriptor.Availability == QueryTextAvailability.Missing)
            {
                if (!allowRawPayloadHydration)
                {
                    descriptor = new QueryTextDescriptorV1(
                        QueryTextAvailability.Restricted,
                        null,
                        null,
                        "Raw Query Store text hydration is disabled for this source.");
                    physical.Add(identity with { Text = descriptor });
                    continue;
                }
                descriptor = await reader.ReadTextDescriptorAsync(
                    identity.DatabaseId, identity.QueryTextId, cancellationToken).ConfigureAwait(false);
                if (descriptor is null)
                {
                    try
                    {
                        var payload = await incrementalSource.ReadQueryTextAsync(
                            identity.DatabaseId, identity.QueryTextId, cancellationToken).ConfigureAwait(false);
                        descriptor = SqlTextNormalizer.Normalize(
                            payload.Text, payload.IsEncrypted, payload.IsRestricted,
                            QuotedIdentifiers(identity.Context.SetOptions));
                        if (descriptor.Availability == QueryTextAvailability.Available && payload.Text is not null)
                            await repository.StoreQueryTextAsync(
                                identity.DatabaseId, identity.QueryTextId, timeProvider.GetUtcNow(),
                                payload.Text, cancellationToken).ConfigureAwait(false);
                    }
                    catch (ProbePermissionDeniedException)
                    {
                        descriptor = new QueryTextDescriptorV1(
                            QueryTextAvailability.Restricted, null, null,
                            "The configured principal cannot fetch this Query Store text.");
                    }
                    catch (ProbeExecutionException)
                    {
                        descriptor = new QueryTextDescriptorV1(
                            QueryTextAvailability.Missing, null, null,
                            "Query Store text is unavailable from the connected source.");
                    }
                    await repository.StoreTextDescriptorAsync(
                        identity.DatabaseId, identity.QueryTextId, descriptor,
                        timeProvider.GetUtcNow(), cancellationToken).ConfigureAwait(false);
                }
            }
            physical.Add(identity with { Text = descriptor });
        }
        var displayText = physical.Select(item => item.Text)
            .FirstOrDefault(item => item.Availability == QueryTextAvailability.Available) ??
            physical[0].Text;
        var plans = new List<QueryPlanSummaryV1>(detail.Plans.Count);
        foreach (var plan in detail.Plans)
        {
            var normalized = await reader.ReadNormalizedPlanAsync(
                plan.PlanId, cancellationToken).ConfigureAwait(false);
            plans.Add(normalized is null ? plan : plan with { Optimization = normalized.Optimization });
        }
        return detail with
        {
            Family = detail.Family with
            {
                Text = displayText,
                NormalizedTextFingerprint = displayText.NormalizedTextFingerprint,
                PhysicalQueries = physical,
            },
            Plans = plans,
        };
    }

    public async Task<NormalizedShowplanV1?> GetPlanAsync(
        string planId,
        CancellationToken cancellationToken)
    {
        var record = await repository.ReadNormalizedPlanAsync(planId, cancellationToken).ConfigureAwait(false);
        if (record is not null) return record;
        if (!allowRawPayloadHydration) return null;
        if (planId.StartsWith("archived:", StringComparison.Ordinal)) return null;
        var separator = planId.LastIndexOf(':');
        if (separator <= 0 || separator == planId.Length - 1) return null;
        var databaseId = planId[..separator];
        var rawPlanId = planId[(separator + 1)..];
        string? xml;
        try
        {
            xml = await incrementalSource.ReadPlanXmlAsync(
                databaseId, rawPlanId, cancellationToken).ConfigureAwait(false);
        }
        catch (ProbeExecutionException)
        {
            return null;
        }
        if (xml is null) return null;
        var normalized = await showplanParser.ParseAsync(planId, xml, cancellationToken).ConfigureAwait(false);
        try
        {
            await repository.StorePlanXmlAsync(
                databaseId, rawPlanId, timeProvider.GetUtcNow(), xml, cancellationToken).ConfigureAwait(false);
        }
        catch (ArgumentException ex) when (ex.ParamName == "payload")
        {
            // Normalized structure remains useful when a valid plan exceeds the encrypted raw-record limit.
        }
        await repository.StoreNormalizedPlanAsync(
            normalized, timeProvider.GetUtcNow(), cancellationToken).ConfigureAwait(false);
        return normalized;
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

    public async Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken)
    {
        var snapshot = await repository.ReadPublishedSnapshotHeaderAsync(cancellationToken).ConfigureAwait(false);
        return statusTracker.Current ?? snapshot?.Status ?? new QueryStoreCollectorStatusV1(
            "1.0", QueryStoreCollectorState.Starting, 0, null, null, null, [],
            "Protected storage is ready; the first connected Query Store cycle has not published.");
    }

    private static bool? QuotedIdentifiers(string? setOptions)
    {
        if (string.IsNullOrWhiteSpace(setOptions)) return null;
        var span = setOptions.AsSpan();
        if (span.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) span = span[2..];
        return BigInteger.TryParse(span, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var value)
            ? (value & 64) != 0
            : null;
    }

    private static string NormalizeMetric(string metric) =>
        metric is "execution" or "executions" ? "execution" : metric;

    private static async Task<PageV1<QueryFamilySummaryV1>> GetLegacyQueriesAsync(
        ProtectedQueryStoreRepository reader,
        QueryStorePublishedSnapshot header,
        string? databaseId,
        string metric,
        int pageSize,
        QueryPageCursor? cursor,
        CancellationToken cancellationToken)
    {
        var snapshot = await reader.ReadPublishedSnapshotAsync(header, cancellationToken)
            .ConfigureAwait(false);
        var normalizedMetric = NormalizeMetric(metric);
        var ordered = snapshot.Families
            .Select(item => item.Family)
            .Where(item => databaseId is null ||
                string.Equals(item.DatabaseId, databaseId, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(item => LegacyMetric(item, normalizedMetric))
            .ThenBy(item => item.FamilyId, StringComparer.Ordinal)
            .ToArray();
        int start;
        try
        {
            start = checked((cursor?.PageIndex ?? 0) * 200 + (cursor?.Offset ?? 0));
        }
        catch (OverflowException)
        {
            throw new QueryStorePageTokenException("The Query Store page token is outside the published index.");
        }
        if (start > ordered.Length)
            throw new QueryStorePageTokenException("The Query Store page token is outside the published index.");
        var families = ordered.Skip(start).Take(pageSize).ToArray();
        var nextOffset = start + families.Length;
        var next = nextOffset < ordered.Length
            ? EncodeToken(new QueryPageCursor(
                header.SnapshotId, metric, databaseId, nextOffset / 200, nextOffset % 200))
            : null;
        return new PageV1<QueryFamilySummaryV1>(
            "1.0", families, next, pageSize, ordered.Length.ToString(CultureInfo.InvariantCulture))
        {
            Evidence = (families.FirstOrDefault()?.Evidence) ??
                ConnectedEvidence(header.PublishedAt, header.Status.State),
        };
    }

    private static LegacyExactNumber LegacyMetric(QueryFamilySummaryV1 family, string metric) =>
        LegacyExactNumber.Parse(metric switch
        {
            "execution" => family.ExecutionCount,
            "duration" => family.TotalDurationMicroseconds,
            "reads" => family.TotalLogicalReads8KiBPages,
            "waits" => family.TotalWaitMilliseconds,
            _ => family.TotalCpuMicroseconds,
        });

    private static PageV1<QueryFamilySummaryV1> Empty(int pageSize, string reason) =>
        new("1.0", [], null, pageSize, null)
        {
            Evidence = new QueryStoreEvidenceV1(
                QueryStoreSource.QueryStore, DataStatus.Unknown, null, null, reason,
                "Missing connected history is unavailable, never numeric zero."),
        };

    private static QueryStoreEvidenceV1 ConnectedEvidence(
        DateTimeOffset observedAt,
        QueryStoreCollectorState state) =>
        new(QueryStoreSource.QueryStore,
            state is QueryStoreCollectorState.Partial or QueryStoreCollectorState.Stale
                ? DataStatus.Stale : DataStatus.Available,
            observedAt, observedAt.AddMinutes(3),
            $"Connected Query Store snapshot is {state}.",
            "Compiled plan structure with aggregate query-level runtime; no actual operator metrics.");

    private static string EncodeToken(QueryPageCursor cursor) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(cursor)));

    private static QueryPageCursor? DecodeToken(string? token)
    {
        if (token is null) return null;
        if (token.Length > 2_048)
            throw new QueryStorePageTokenException("The Query Store page token is too long.");
        try
        {
            var cursor = JsonSerializer.Deserialize<QueryPageCursor>(
                Convert.FromBase64String(token)) ??
                throw new QueryStorePageTokenException("The Query Store page token is malformed.");
            if (cursor.SnapshotId is null || cursor.SnapshotId.Length is < 1 or > 128 ||
                cursor.Metric is not ("cpu" or "execution" or "executions" or "duration" or "reads" or "waits") ||
                cursor.DatabaseId?.Length > 256 || cursor.PageIndex < 0 || cursor.Offset is < 0 or >= 200)
                throw new QueryStorePageTokenException("The Query Store page token contains invalid values.");
            return cursor;
        }
        catch (Exception ex) when (ex is FormatException or JsonException or OverflowException or ArgumentException)
        {
            throw new QueryStorePageTokenException("The Query Store page token is malformed.");
        }
    }

    private sealed record QueryPageCursor(
        string SnapshotId,
        string Metric,
        string? DatabaseId,
        int PageIndex,
        int Offset);

    private readonly record struct LegacyExactNumber(BigInteger Unscaled, int Scale)
        : IComparable<LegacyExactNumber>
    {
        public static LegacyExactNumber Parse(string value)
        {
            var span = value.AsSpan();
            var negative = span.Length > 0 && span[0] == '-';
            if (negative) span = span[1..];
            var point = span.IndexOf('.');
            var scale = point < 0 ? 0 : span.Length - point - 1;
            var digits = point < 0 ? span.ToString() : string.Concat(span[..point], span[(point + 1)..]);
            var unscaled = BigInteger.Parse(digits, CultureInfo.InvariantCulture);
            return new(negative ? -unscaled : unscaled, scale);
        }

        public int CompareTo(LegacyExactNumber other)
        {
            var scale = Math.Max(Scale, other.Scale);
            return (Unscaled * BigInteger.Pow(10, scale - Scale))
                .CompareTo(other.Unscaled * BigInteger.Pow(10, scale - other.Scale));
        }
    }
}
