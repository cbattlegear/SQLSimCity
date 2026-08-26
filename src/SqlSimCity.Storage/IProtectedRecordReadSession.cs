namespace SqlSimCity.Storage;

/// <summary>
/// A bounded batch of point reads served from one storage connection with a reused
/// command, closed deterministically when the session is disposed.
///
/// <see cref="IProtectedRecordStore.GetAsync"/> opens and closes its own connection, which
/// is right for a single read and wrong for a loop: a page of Query Store summaries reads
/// dozens of records, and connection setup dominates the work by orders of magnitude. A
/// session amortises that without enabling connection pooling, which would keep a native
/// handle -- and on Windows a file lock -- alive past disposal.
///
/// A session is not thread-safe in the sense of being parallel: one connection cannot run
/// two commands at once, so concurrent reads are serialized rather than interleaved. Hold a
/// session for a bounded batch of work and dispose it; never cache one for the process
/// lifetime.
/// </summary>
public interface IProtectedRecordReadSession : IAsyncDisposable
{
    /// <summary>Reads a caller-owned record, or <c>null</c>; dispose it to zero the payload.</summary>
    Task<ProtectedRecord?> GetAsync(ProtectedRecordId id, CancellationToken cancellationToken = default);
}

/// <summary>
/// The default session for stores with no per-read connection cost: it holds nothing and
/// forwards every read to the store.
/// </summary>
internal sealed class PassThroughProtectedRecordReadSession(IProtectedRecordStore store)
    : IProtectedRecordReadSession
{
    public Task<ProtectedRecord?> GetAsync(
        ProtectedRecordId id, CancellationToken cancellationToken = default) =>
        store.GetAsync(id, cancellationToken);

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
