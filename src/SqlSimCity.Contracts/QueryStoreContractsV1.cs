namespace SqlSimCity.Contracts.V1;

public enum QueryTextAvailability { Available, Restricted, Encrypted, Missing }
public enum QueryStoreExecutionType { Regular, Aborted, Exception }
public enum QueryPlanType { Compiled, Dispatcher, Variant, Unknown }
public enum QueryOptimizationKind { None, ParameterSensitivePlan, OptionalParameterPlanOptimization }
public enum QueryStoreSource { Fixture, QueryStore, ImportedArchive, EdgeConnector }

public sealed record QueryStoreEvidenceV1(
    QueryStoreSource Source,
    DataStatus Status,
    DateTimeOffset? ObservedAt,
    DateTimeOffset? FreshUntil,
    string Reason,
    string Caveat);

public sealed record QueryTextDescriptorV1(
    QueryTextAvailability Availability,
    string? NormalizedText,
    string? NormalizedTextFingerprint,
    string Reason);

public sealed record QueryContextSettingsV1(
    string ContextSettingsId,
    string? Language,
    string? DateFormat,
    string? DateFirst,
    string? CompatibilityLevel,
    string? SetOptions);

public sealed record PhysicalQueryIdentityV1(
    string DatabaseId,
    string QueryId,
    string QueryTextId,
    string QueryHash,
    QueryContextSettingsV1 Context,
    QueryTextDescriptorV1 Text);

public sealed record RuntimeBucketV1(
    string PlanId,
    string IntervalId,
    string EpochId,
    DateTimeOffset IntervalStart,
    DateTimeOffset IntervalEnd,
    QueryStoreExecutionType ExecutionType,
    string ReplicaGroupId,
    string ExecutionCount,
    decimal AverageDurationMicroseconds,
    decimal AverageCpuMicroseconds,
    decimal AverageLogicalReads8KiBPages,
    string TotalDurationMicroseconds,
    string TotalCpuMicroseconds,
    string TotalLogicalReads8KiBPages,
    IReadOnlyDictionary<string, string> WaitMilliseconds,
    QueryStoreEvidenceV1 Evidence);

public sealed record QueryPlanSummaryV1(
    string PlanId,
    string QueryId,
    string QueryPlanHash,
    QueryPlanType PlanType,
    QueryOptimizationKind Optimization,
    string? DispatcherPlanId,
    bool RuntimeCounted,
    bool IsForced,
    string? ForcingType,
    string ForceFailureCount,
    string? LastForceFailureReason,
    string EngineVersion,
    string CompatibilityLevel,
    DateTimeOffset LastExecutionAt,
    QueryStoreEvidenceV1 Evidence);

public sealed record QueryFamilySummaryV1(
    string FamilyId,
    string DatabaseId,
    string QueryHash,
    string? NormalizedTextFingerprint,
    QueryTextDescriptorV1 Text,
    IReadOnlyList<PhysicalQueryIdentityV1> PhysicalQueries,
    string ExecutionCount,
    string TotalCpuMicroseconds,
    string TotalDurationMicroseconds,
    string TotalLogicalReads8KiBPages,
    string TotalWaitMilliseconds,
    DateTimeOffset FirstObservedAt,
    DateTimeOffset LastObservedAt,
    QueryStoreEvidenceV1 Evidence);

public sealed record QueryFamilyDetailV1(
    string SchemaVersion,
    QueryFamilySummaryV1 Family,
    IReadOnlyList<QueryPlanSummaryV1> Plans,
    IReadOnlyList<RuntimeBucketV1> Runtime);

public sealed record PageV1<T>(
    string SchemaVersion,
    IReadOnlyList<T> Items,
    string? NextPageToken,
    int PageSize,
    string? TotalCount)
{
    public QueryStoreEvidenceV1? Evidence { get; init; }
}

public sealed record ShowplanObjectV1(string? Database, string? Schema, string? Table, string? Index);
public sealed record ShowplanWarningV1(string Kind, string? Detail);

/// <summary>
/// One index the optimizer says it would have liked, taken from the plan-level
/// <c>&lt;MissingIndexes&gt;</c> block rather than from any operator's warnings.
/// <para>
/// It is emphatically <em>not</em> a node warning, which is why it needs its own home on the plan.
/// <c>&lt;MissingIndexes&gt;</c> is a child of <c>&lt;QueryPlan&gt;</c> and is written before the
/// first <c>&lt;RelOp&gt;</c>, so a parser that only records warnings while an operator is open sees
/// it and drops it. Reading a missing index out of <see cref="ShowplanNodeV1.Warnings"/> therefore
/// finds nothing, no matter how many indexes the optimizer asked for.
/// </para>
/// <para>
/// <paramref name="ImpactPercent"/> is the optimizer's own estimate of how much cheaper this
/// statement's plan could have been, 0..100. It is a compile-time estimate about one statement, not
/// a measurement and not a recommendation for the workload as a whole: the same index can be
/// suggested by many plans and creating it costs writes that no plan reports.
/// </para>
/// </summary>
public sealed record ShowplanMissingIndexV1(
    string? Database,
    string? Schema,
    string? Table,
    decimal? ImpactPercent,
    IReadOnlyList<string> EqualityColumns,
    IReadOnlyList<string> InequalityColumns,
    IReadOnlyList<string> IncludedColumns);
public sealed record ShowplanNodeV1(
    int NodeId,
    int? ParentNodeId,
    string LogicalOperation,
    string PhysicalOperation,
    decimal? EstimatedRows,
    decimal? EstimatedCpuCost,
    decimal? EstimatedIoCost,
    decimal? EstimatedTotalSubtreeCost,
    bool Parallel,
    ShowplanObjectV1? ObjectReference,
    string? Predicate,
    IReadOnlyList<ShowplanWarningV1> Warnings,

    /// <summary>
    /// The optimizer's <c>AvgRowSize</c> for the rows this operator emits, in bytes.
    /// <para>
    /// Appended rather than placed next to <see cref="EstimatedRows"/> so that every existing
    /// construction site keeps compiling; the ordering here carries no meaning.
    /// </para>
    /// <para>
    /// Null means the plan did not state a row size for this operator, never that its rows are
    /// free. Multiplied by <see cref="EstimatedRows"/> it gives the bytes the optimizer expected to
    /// move through this operator -- an estimate made at compile time, not a measurement of any
    /// execution.
    /// </para>
    /// </summary>
    decimal? EstimatedRowSizeBytes = null);

public sealed record NormalizedShowplanV1(
    string SchemaVersion,
    string PlanId,
    string ShowplanVersion,
    string? CardinalityEstimatorVersion,
    decimal? SerialDesiredMemoryKiB,
    decimal? SerialRequiredMemoryKiB,
    IReadOnlyList<ShowplanNodeV1> Nodes,
    QueryOptimizationKind Optimization,
    string? DispatcherExpression,
    string StructuralFingerprint,
    string RuntimeOverlayCaveat,
    QueryStoreEvidenceV1 Evidence,

    /// <summary>
    /// Plan-level missing-index suggestions, or <see langword="null"/> when this plan was normalized
    /// by a build that did not read them.
    /// <para>
    /// The two empty answers are different claims and only one of them is about the plan. An empty
    /// list means the optimizer asked for nothing; <see langword="null"/> means nobody looked, which
    /// is what an archive normalized before this field existed can honestly say. Collapsing null
    /// into empty would report "no index would have helped" on evidence that was never gathered.
    /// </para>
    /// </summary>
    IReadOnlyList<ShowplanMissingIndexV1>? MissingIndexes = null);

public sealed record PlanChangeV1(string Path, string ChangeKind, string? Before, string? After);

public sealed record PlanComparisonV1(
    string SchemaVersion,
    string LeftPlanId,
    string RightPlanId,
    bool StructurallyEqual,
    IReadOnlyList<PlanChangeV1> Changes,
    string Source,
    string Caveat);

/// <summary>
/// What one point read against a Query Store source actually established. The distinction between
/// the two empty answers is the whole point of the type: <see cref="Absent"/> is a fact about the
/// target -- there is no such plan or family -- and a caller may reason from it, while
/// <see cref="Unavailable"/> is a fact about the source, which could not answer. Unavailable
/// evidence has to stay unavailable; collapsing it into "one item fewer" makes a partial evaluation
/// read as a complete one.
/// </summary>
public enum QueryStoreReadOutcome { Available, Absent, Unavailable }

/// <summary>
/// The outcome of one point read against a Query Store source, carrying the same
/// <see cref="DataStatus"/>/reason vocabulary every other contract here uses, so an unavailable read
/// can be disclosed exactly the way unavailable evidence is disclosed elsewhere.
/// </summary>
/// <param name="Outcome">Which of the three answers this is.</param>
/// <param name="Value">The record, and only when <paramref name="Outcome"/> is
/// <see cref="QueryStoreReadOutcome.Available"/>.</param>
/// <param name="Status">
/// How good the answer is, not what it contains. An <see cref="QueryStoreReadOutcome.Absent"/> read
/// is <see cref="DataStatus.Available"/>: the source answered, and the answer is that there is no
/// such record. Only an <see cref="QueryStoreReadOutcome.Unavailable"/> read carries a degraded
/// status, and it says why -- disconnected, permission denied, disabled, unsupported, or unknown.
/// </param>
/// <param name="Reason">A caller-safe sentence fit to disclose to whoever reads the evidence.</param>
public sealed record QueryStoreReadV1<T>(
    QueryStoreReadOutcome Outcome,
    T? Value,
    DataStatus Status,
    string Reason) where T : class;

/// <summary>
/// Builds <see cref="QueryStoreReadV1{T}"/> values. Non-generic on purpose so the factories read as
/// <c>QueryStoreRead.Unavailable&lt;NormalizedShowplanV1&gt;(...)</c> at the call site.
/// </summary>
public static class QueryStoreRead
{
    public static QueryStoreReadV1<T> Available<T>(T value) where T : class =>
        new(QueryStoreReadOutcome.Available, value, DataStatus.Available,
            "The Query Store source returned this record.");

    public static QueryStoreReadV1<T> Absent<T>(string reason) where T : class =>
        new(QueryStoreReadOutcome.Absent, null, DataStatus.Available, reason);

    public static QueryStoreReadV1<T> Unavailable<T>(DataStatus status, string reason) where T : class =>
        new(QueryStoreReadOutcome.Unavailable, null, status, reason);

    /// <summary>
    /// The read to report for a plan comparison that produced nothing, given how each side read.
    /// Unavailability wins over absence: a side the source could not read is not a side that is not
    /// there, and a comparison never attempted must not be reported as one that came back empty.
    /// </summary>
    public static QueryStoreReadV1<PlanComparisonV1> NoComparison(
        QueryStoreReadV1<NormalizedShowplanV1> left,
        QueryStoreReadV1<NormalizedShowplanV1> right)
    {
        if (Blocked(left, "left") is { } byLeft) return byLeft;
        if (Blocked(right, "right") is { } byRight) return byRight;
        var missing = new List<string>(2);
        if (left.Value is null) missing.Add($"the left Showplan is not there ({left.Reason})");
        if (right.Value is null) missing.Add($"the right Showplan is not there ({right.Reason})");
        return Absent<PlanComparisonV1>(
            $"No comparison is claimed because {string.Join(" and ", missing)}.");
    }

    private static QueryStoreReadV1<PlanComparisonV1>? Blocked(
        QueryStoreReadV1<NormalizedShowplanV1> side, string which) =>
        side.Outcome == QueryStoreReadOutcome.Unavailable
            ? Unavailable<PlanComparisonV1>(
                side.Status,
                $"The {which} Showplan could not be read, so no comparison is claimed. {side.Reason}")
            : null;
}

public enum QueryStoreCollectorState { Disabled, Starting, Collecting, Ready, Partial, Stale, BackingOff, Failed }

public sealed record QueryStoreDatabaseStatusV1(
    string DatabaseId,
    QueryStoreCollectionStateV1 State,
    string ResetEpoch,
    DateTimeOffset? CollectedThrough,
    DateTimeOffset? OldestAvailableAt,
    string Reason);

public enum QueryStoreCollectionStateV1
{
    ReadWrite, ReadOnly, ReadCaptureSecondary, Off, Error, PermissionDenied, Unsupported, Unknown,
}

public sealed record QueryStoreCollectorStatusV1(
    string SchemaVersion,
    QueryStoreCollectorState State,
    long Sequence,
    DateTimeOffset? LastStartedAt,
    DateTimeOffset? LastPublishedAt,
    DateTimeOffset? NextAttemptAt,
    IReadOnlyList<QueryStoreDatabaseStatusV1> Databases,
    string Reason);
