namespace SqlSimCity.Storage;

/// <summary>
/// What one <see cref="IProtectedRecordStore.ReplaceSetAsync"/> actually cost. The store is the
/// only place these are knowable: the caller hands over a lazily built sequence, so it does not
/// know how many records it produced or how many bytes they came to, and the transaction that
/// serializes writers opens and commits entirely inside the store.
/// </summary>
/// <param name="RecordsDeleted">Rows the prefix delete removed before the replacements landed.</param>
/// <param name="DeletedBytes">Bytes those rows occupied, envelope framing included.</param>
/// <param name="RecordsWritten">Replacement records the store accepted.</param>
/// <param name="PayloadBytes">Plaintext bytes across those replacements.</param>
/// <param name="StoredBytes">Bytes actually written, envelope framing included.</param>
/// <param name="WriteLockHold">
/// How long the store held writers out: measured from immediately before the first write
/// statement -- which is where a deferred SQLite transaction takes the write lock, not
/// <c>BEGIN</c> -- until the commit returns. Excludes connection setup. The caller's own
/// serialization is prepared on a producer task that starts before the transaction opens, so
/// this is the statements plus whatever the writer had to wait for that producer to hand over,
/// not the producer's whole cost. A store with no write lock reports the equivalent exclusive
/// section.
/// </param>
public readonly record struct ProtectedSetReplacement(
    int RecordsDeleted,
    long DeletedBytes,
    int RecordsWritten,
    long PayloadBytes,
    long StoredBytes,
    TimeSpan WriteLockHold)
{
    public static ProtectedSetReplacement operator +(
        ProtectedSetReplacement left, ProtectedSetReplacement right) =>
        new(left.RecordsDeleted + right.RecordsDeleted,
            left.DeletedBytes + right.DeletedBytes,
            left.RecordsWritten + right.RecordsWritten,
            left.PayloadBytes + right.PayloadBytes,
            left.StoredBytes + right.StoredBytes,
            left.WriteLockHold + right.WriteLockHold);
}
