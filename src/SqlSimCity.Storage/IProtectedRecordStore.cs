namespace SqlSimCity.Storage;

/// <summary>
/// Async storage for operational records. <see cref="ProtectedRecordId"/>, record kind,
/// captured timestamp, and <see cref="StorageResolution"/> are plaintext metadata, and
/// <c>payload</c> bytes are stored in the clear so captured plans, query text, and workload
/// evidence stay inspectable -- SQL SimCity exists to visualize this data, not to obscure it.
/// Records written by earlier versions remain AES-256-GCM sealed and are still readable.
/// Plan XML can contain literal parameter values from the observed database, so protect the
/// storage directory with filesystem permissions.
/// </summary>
public interface IProtectedRecordStore
{
    /// <summary>Maximum payload bytes accepted by one record.</summary>
    int MaxPayloadBytes { get; }

    /// <summary>Upserts a record under its opaque id.</summary>
    Task PutAsync(
        ProtectedRecordId id,
        string recordKind,
        DateTimeOffset capturedAt,
        StorageResolution resolution,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken = default);

    /// <summary>Reads a caller-owned record, or <c>null</c>; dispose it to zero the payload.</summary>
    Task<ProtectedRecord?> GetAsync(ProtectedRecordId id, CancellationToken cancellationToken = default);

    /// <summary>
    /// Begins a bounded batch of reads over shared storage state. Callers that read many
    /// records in a loop should use one instead of repeating <see cref="GetAsync"/>, which
    /// pays full connection setup per record in a connection-backed store. The default holds
    /// nothing and forwards to <see cref="GetAsync"/>, which is already optimal for stores
    /// with no per-read setup cost.
    /// </summary>
    Task<IProtectedRecordReadSession> BeginReadSessionAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<IProtectedRecordReadSession>(new PassThroughProtectedRecordReadSession(this));

    /// <summary>Deletes a record. Returns <c>false</c> if the id was absent.</summary>
    Task<bool> DeleteAsync(ProtectedRecordId id, CancellationToken cancellationToken = default);

    /// <summary>
    /// Atomically replaces every record whose opaque id starts with <paramref name="idPrefix"/>.
    /// The replacement sequence is consumed inside one storage transaction. Returns what the
    /// replacement cost, because the caller hands over a lazy sequence and cannot otherwise
    /// know how much was written or how long writers were held out.
    /// <para>
    /// An implementation may enumerate <paramref name="records"/> on another thread to keep the
    /// caller's serialization off its write lock, so the sequence must not require the calling
    /// thread. It is still enumerated once, in order, and a payload it yields is only read
    /// before the enumerator advances.
    /// </para>
    /// </summary>
    Task<ProtectedSetReplacement> ReplaceSetAsync(
        string idPrefix,
        IEnumerable<ProtectedRecordWrite> records,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Reports retained size, per-kind composition and the prune backlog. Intended for periodic
    /// operator telemetry rather than per-request use: an implementation may have to walk every
    /// retained record to answer it.
    /// </summary>
    Task<ProtectedStorageUsage> MeasureUsageAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Ids of the oldest retained records among <paramref name="recordKinds"/>, oldest captured
    /// first, at most <paramref name="limit"/> of them. Deliberately returns ids rather than
    /// deleting: only the caller knows which ids belong to the same logical object, and evicting
    /// half of a chunked one would leave a manifest pointing at chunks that are gone.
    /// </summary>
    Task<IReadOnlyList<ProtectedRecordId>> ListOldestAsync(
        IReadOnlyCollection<string> recordKinds,
        int limit,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Prunes records older than the configured retention window for their
    /// resolution, deleting at most the configured <c>PruneBatchSize</c> per
    /// invocation. Callers repeat it to drain additional expired rows. Never
    /// deletes canary or configuration metadata.
    /// </summary>
    Task<int> PruneExpiredAsync(CancellationToken cancellationToken = default);
}

public sealed record ProtectedRecordWrite(
    ProtectedRecordId Id,
    string RecordKind,
    DateTimeOffset CapturedAt,
    StorageResolution Resolution,
    ReadOnlyMemory<byte> Payload);
