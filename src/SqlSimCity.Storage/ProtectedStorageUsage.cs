namespace SqlSimCity.Storage;

/// <summary>
/// What the store is holding right now, so an operator can see retained size and whether
/// retention is keeping up rather than inferring both from arithmetic.
/// </summary>
/// <param name="RecordCount">Records currently retained.</param>
/// <param name="StoredBytes">Sum of stored record sizes, envelope framing included.</param>
/// <param name="OnDiskBytes">
/// Bytes the store occupies on the filesystem, including any write-ahead log. Larger than
/// <see cref="StoredBytes"/> by page overhead and free pages a delete left behind, and that gap
/// is the point: it is what an operator's disk actually loses. Zero for a store with no files.
/// </param>
/// <param name="ExpiredRecordCount">
/// Records already past their retention window that <see cref="IProtectedRecordStore.PruneExpiredAsync"/>
/// has not deleted yet -- the prune backlog. One prune deletes at most <c>PruneBatchSize</c>, so a
/// backlog above that means retention is running behind and the store keeps expired records for
/// at least backlog/batch more cycles.
/// </param>
/// <param name="Kinds">Per-record-kind breakdown, descending by <see cref="ProtectedRecordKindUsage.StoredBytes"/>.</param>
public sealed record ProtectedStorageUsage(
    long RecordCount,
    long StoredBytes,
    long OnDiskBytes,
    long ExpiredRecordCount,
    IReadOnlyList<ProtectedRecordKindUsage> Kinds)
{
    public static ProtectedStorageUsage Empty { get; } = new(0, 0, 0, 0, []);

    /// <summary>
    /// Retained bytes across the record kinds hydrated on demand rather than by collection --
    /// the plan cache. Named kinds that are absent contribute nothing.
    /// </summary>
    public long StoredBytesForKinds(IReadOnlyCollection<string> recordKinds)
    {
        ArgumentNullException.ThrowIfNull(recordKinds);
        var total = 0L;
        foreach (var kind in Kinds)
            if (recordKinds.Contains(kind.RecordKind))
                total += kind.StoredBytes;
        return total;
    }

    /// <inheritdoc cref="StoredBytesForKinds"/>
    public long RecordCountForKinds(IReadOnlyCollection<string> recordKinds)
    {
        ArgumentNullException.ThrowIfNull(recordKinds);
        var total = 0L;
        foreach (var kind in Kinds)
            if (recordKinds.Contains(kind.RecordKind))
                total += kind.RecordCount;
        return total;
    }
}

public sealed record ProtectedRecordKindUsage(string RecordKind, long RecordCount, long StoredBytes);
