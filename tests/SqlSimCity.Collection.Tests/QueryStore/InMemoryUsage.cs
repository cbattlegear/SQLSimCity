using SqlSimCity.Storage;

namespace SqlSimCity.Collection.Tests.QueryStore;

/// <summary>
/// The composition half of <see cref="IProtectedRecordStore.MeasureUsageAsync"/> for the
/// dictionary-backed doubles in this project. Shared so a double cannot answer a size question
/// with a plausible constant: a test that asserts on retained bytes has to be measuring records
/// that were really written.
/// </summary>
internal static class InMemoryUsage
{
    public static ProtectedStorageUsage Measure(IEnumerable<ProtectedRecord> records)
    {
        var kinds = records
            .GroupBy(record => record.RecordKind, StringComparer.Ordinal)
            .Select(group => new ProtectedRecordKindUsage(
                group.Key, group.Count(), group.Sum(record => (long)record.Payload.Length)))
            .OrderByDescending(kind => kind.StoredBytes)
            .ThenBy(kind => kind.RecordKind, StringComparer.Ordinal)
            .ToArray();
        return new ProtectedStorageUsage(
            kinds.Sum(kind => kind.RecordCount),
            kinds.Sum(kind => kind.StoredBytes),
            0,
            0,
            kinds);
    }

    /// <summary>
    /// Matches the SQLite store's ordering, including the id tiebreak. Without it a batch of
    /// records captured in the same instant -- every record of one hydrated plan -- could come
    /// back in a different order each call and an eviction loop would never converge.
    /// </summary>
    public static IReadOnlyList<ProtectedRecordId> ListOldest(
        IEnumerable<KeyValuePair<string, ProtectedRecord>> records,
        IReadOnlyCollection<string> recordKinds,
        int limit) =>
        records
            .Where(pair => recordKinds.Contains(pair.Value.RecordKind))
            .OrderBy(pair => pair.Value.CapturedAt)
            .ThenBy(pair => pair.Key, StringComparer.Ordinal)
            .Take(limit)
            .Select(pair => new ProtectedRecordId(pair.Key))
            .ToArray();
}
