using System.Collections.ObjectModel;
using System.Globalization;
using System.Numerics;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

public sealed record DatabaseCitySchemaEvidence(string SchemaId, string Name, int? LayoutOrdinal = null);

public sealed record DatabaseCityObjectEvidence(
    string ObjectId,
    string SchemaId,
    string Name,
    DatabaseObjectKind Kind,
    string? ReservedPages8KiB,
    string? UsedPages8KiB,
    IReadOnlyList<DatabaseCityIndexV1> Indexes,
    IReadOnlyList<string> QueryFamilyIds)
{
    public DatabaseCityDirectActivityV1? DirectActivity { get; init; }
    public DatabaseCityAttributedExposureV1? AttributedExposure { get; init; }
    public string? SizeReason { get; init; }
    public int? LayoutOrdinal { get; init; }

    /// <summary>
    /// How stale this object's statistics are, or <see langword="null"/> when nothing measured them.
    /// Null is not freshness and must never be projected as such.
    /// </summary>
    public DatabaseCityStatisticsAgeV1? Statistics { get; init; }
}

public sealed record DatabaseCityQueryEvidence(
    string FamilyId,
    string QueryHash,
    string ExecutionCount,
    string TotalCpuMicroseconds,
    string TotalDurationMicroseconds,
    string TotalLogicalReads8KiBPages,
    string TotalWaitMilliseconds,
    IReadOnlyList<string> ObjectIds,
    QueryAttributionConfidence Confidence,
    string Rationale)
{
    /// <summary>
    /// Captured wait milliseconds keyed by verbatim Query Store <c>wait_category_desc</c>. Empty
    /// means the category breakdown was not captured, never that the family waited for nothing.
    /// </summary>
    public IReadOnlyDictionary<string, string> WaitMillisecondsByCategory { get; init; } =
        ReadOnlyDictionary<string, string>.Empty;

    /// <summary>
    /// The same measured wait time spread across the objects the family's plans read, in proportion
    /// to estimated plan cost. The split is modelled; only the total it divides is measured.
    /// </summary>
    public DatabaseCityWaitAttributionV1 WaitAttribution { get; init; } = DatabaseCityWaitAttributionV1.None;

    /// <summary>
    /// Estimated bytes one execution of this family moves, per object, from the optimizer's own row
    /// counts and row sizes. Null when no retained plan stated both. Modelled, not measured.
    /// </summary>
    public DatabaseCityPlanDataVolumeV1? PlanDataVolume { get; init; }

    /// <summary>
    /// What this family did inside the recent traffic window, which is what the map grades street
    /// colour from. Null when no window was configured for this page.
    /// </summary>
    public DatabaseCityRecentActivityV1? RecentActivity { get; init; }
}

public sealed record DatabaseCityWorkloadProjection(
    IReadOnlyList<DatabaseCityQueryEvidence> Top,
    DatabaseCityWorkloadAggregateV1 Other);

public static class DatabaseCityProjector
{
    private static readonly EvidenceV1 UnavailableDirectEvidence = new(
        EvidenceSource.NotProbed, DataStatus.Unknown, null, null,
        "Direct index DMV activity was not available for this object.");

    private static readonly EvidenceV1 UnavailableAttributedEvidence = new(
        EvidenceSource.NotProbed, DataStatus.Unknown, null, null,
        "No normalized plan attribution was available for this object.");

    public static IReadOnlyList<DatabaseCityObjectV1> ProjectObjects(
        IEnumerable<DatabaseCitySchemaEvidence> schemas,
        IEnumerable<DatabaseCityObjectEvidence> objects)
    {
        ArgumentNullException.ThrowIfNull(schemas);
        ArgumentNullException.ThrowIfNull(objects);

        var orderedSchemas = schemas
            .OrderBy(schema => schema.SchemaId, StringComparer.Ordinal)
            .ToArray();
        var schemaOrdinals = orderedSchemas
            .Select((schema, index) => (schema.SchemaId, index))
            .ToDictionary(value => value.SchemaId, value => value.index, StringComparer.Ordinal);
        var schemaNames = orderedSchemas.ToDictionary(
            schema => schema.SchemaId, schema => schema.Name, StringComparer.Ordinal);
        var schemaLayoutOrdinals = orderedSchemas
            .Select((schema, index) => (schema.SchemaId, Ordinal: schema.LayoutOrdinal ?? index))
            .ToDictionary(value => value.SchemaId, value => value.Ordinal, StringComparer.Ordinal);
        // One counter for the whole database, not one per schema. The connected collector numbers
        // objects across the database, so counting within a schema here gave the same field two
        // different meanings depending on which collector filled it (#49). Database-wide is the one
        // that both can honour: a schema cannot know its own objects' positions until every schema
        // has been read, but a collector paging the database always can.
        var runningObjectOrdinal = 0;

        return objects
            .OrderBy(item => item.SchemaId, StringComparer.Ordinal)
            .ThenBy(item => item.ObjectId, StringComparer.Ordinal)
            .Select(item =>
            {
                if (!schemaOrdinals.TryGetValue(item.SchemaId, out var neighborhoodOrdinal) ||
                    !schemaNames.TryGetValue(item.SchemaId, out var schemaName))
                    throw new ArgumentException($"Object {item.ObjectId} references unknown schema {item.SchemaId}.", nameof(objects));

                var sequentialObjectOrdinal = runningObjectOrdinal++;
                var objectOrdinal = item.LayoutOrdinal ?? sequentialObjectOrdinal;
                neighborhoodOrdinal = schemaLayoutOrdinals[item.SchemaId];
                var sizeKnown = item.ReservedPages8KiB is not null && item.UsedPages8KiB is not null;
                var reservedBytes = sizeKnown ? PagesToBytes(item.ReservedPages8KiB!) : null;
                var usedBytes = sizeKnown ? PagesToBytes(item.UsedPages8KiB!) : null;
                if (sizeKnown && ParseUnsigned(item.UsedPages8KiB!) > ParseUnsigned(item.ReservedPages8KiB!))
                    throw new ArgumentException($"Object {item.ObjectId} has used pages greater than reserved pages.", nameof(objects));

                return new DatabaseCityObjectV1(
                    item.ObjectId,
                    item.SchemaId,
                    schemaName,
                    item.Name,
                    item.Kind,
                    item.ReservedPages8KiB,
                    item.UsedPages8KiB,
                    reservedBytes,
                    usedBytes,
                    sizeKnown ? MeasurementStatus.Known : MeasurementStatus.Unknown,
                    sizeKnown ? null : item.SizeReason ?? "Object page counts are unavailable; geometry is nonquantitative.",
                    new DatabaseCityLayoutV1(
                        neighborhoodOrdinal,
                        objectOrdinal,
                        neighborhoodOrdinal * 160L + (objectOrdinal % 2) * 72L,
                        (objectOrdinal / 2L) * 72L),
                    item.Indexes.OrderBy(index => index.IndexId, StringComparer.Ordinal).ToArray(),
                    item.DirectActivity ?? new DatabaseCityDirectActivityV1(null, null, UnavailableDirectEvidence),
                    item.AttributedExposure ?? new DatabaseCityAttributedExposureV1(
                        null, null, null, null, QueryAttributionConfidence.Unknown,
                        "No normalized plan evidence names this object.", UnavailableAttributedEvidence),
                    item.Statistics);
            })
            .ToArray();
    }

    public static DatabaseCityWorkloadProjection ProjectWorkload(
        IEnumerable<DatabaseCityQueryEvidence> families,
        DatabaseCityMetric metric,
        int topCount,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(families);
        if (topCount is < 1 or > 100)
            throw new ArgumentOutOfRangeException(nameof(topCount));

        var all = new WorkloadTotals();
        var top = new SortedSet<RankedFamily>(RankedFamilyComparer.Instance);
        foreach (var family in families)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var ranked = new RankedFamily(ParseMetric(family, metric), family);
            all.Add(family);
            top.Add(ranked);
            if (top.Count > topCount)
                top.Remove(top.Min!);
        }

        var orderedTop = top
            .OrderByDescending(item => item.Metric)
            .ThenBy(item => item.Family.FamilyId, StringComparer.Ordinal)
            .Select(item => item.Family)
            .ToArray();
        var other = all;
        foreach (var family in orderedTop)
            other.Subtract(family);

        var evidence = new EvidenceV1(
            EvidenceSource.QueryStoreAggregate, DataStatus.Available, null, null,
            "Aggregate of query families outside the deterministic top-N; not hidden or discarded workload.");
        return new DatabaseCityWorkloadProjection(orderedTop, other.ToContract(evidence));
    }

    private static BigInteger ParseMetric(DatabaseCityQueryEvidence family, DatabaseCityMetric metric) =>
        metric switch
        {
            DatabaseCityMetric.Cpu => ParseUnsigned(family.TotalCpuMicroseconds),
            DatabaseCityMetric.Duration => ParseUnsigned(family.TotalDurationMicroseconds),
            DatabaseCityMetric.Reads => ParseUnsigned(family.TotalLogicalReads8KiBPages),
            DatabaseCityMetric.Executions => ParseUnsigned(family.ExecutionCount),
            _ => throw new ArgumentOutOfRangeException(nameof(metric)),
        };

    private static string PagesToBytes(string pages) =>
        (ParseUnsigned(pages) * 8192).ToString(CultureInfo.InvariantCulture);

    private static BigInteger ParseUnsigned(string value)
    {
        if (!BigInteger.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) ||
            parsed < BigInteger.Zero)
            throw new ArgumentException("Exact counters must be nonnegative decimal strings.", nameof(value));
        return parsed;
    }

    private sealed record RankedFamily(BigInteger Metric, DatabaseCityQueryEvidence Family);

    private sealed class RankedFamilyComparer : IComparer<RankedFamily>
    {
        public static RankedFamilyComparer Instance { get; } = new();

        public int Compare(RankedFamily? left, RankedFamily? right)
        {
            if (ReferenceEquals(left, right)) return 0;
            if (left is null) return -1;
            if (right is null) return 1;
            var metric = left.Metric.CompareTo(right.Metric);
            if (metric != 0) return metric;
            return -StringComparer.Ordinal.Compare(left.Family.FamilyId, right.Family.FamilyId);
        }
    }

    private sealed class WorkloadTotals
    {
        private BigInteger _familyCount;
        private BigInteger _executions;
        private BigInteger _cpu;
        private BigInteger _duration;
        private BigInteger _reads;
        private BigInteger _waits;

        public void Add(DatabaseCityQueryEvidence family)
        {
            _familyCount++;
            _executions += ParseUnsigned(family.ExecutionCount);
            _cpu += ParseUnsigned(family.TotalCpuMicroseconds);
            _duration += ParseUnsigned(family.TotalDurationMicroseconds);
            _reads += ParseUnsigned(family.TotalLogicalReads8KiBPages);
            _waits += ParseUnsigned(family.TotalWaitMilliseconds);
        }

        public void Subtract(DatabaseCityQueryEvidence family)
        {
            _familyCount--;
            _executions -= ParseUnsigned(family.ExecutionCount);
            _cpu -= ParseUnsigned(family.TotalCpuMicroseconds);
            _duration -= ParseUnsigned(family.TotalDurationMicroseconds);
            _reads -= ParseUnsigned(family.TotalLogicalReads8KiBPages);
            _waits -= ParseUnsigned(family.TotalWaitMilliseconds);
        }

        public DatabaseCityWorkloadAggregateV1 ToContract(EvidenceV1 evidence) => new(
            _familyCount.ToString(CultureInfo.InvariantCulture),
            _executions.ToString(CultureInfo.InvariantCulture),
            _cpu.ToString(CultureInfo.InvariantCulture),
            _duration.ToString(CultureInfo.InvariantCulture),
            _reads.ToString(CultureInfo.InvariantCulture),
            _waits.ToString(CultureInfo.InvariantCulture),
            evidence);
    }
}
