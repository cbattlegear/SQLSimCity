using System.Security.Cryptography;
using SqlSimCity.Storage;

namespace SqlSimCity.Edge.Connector;

public sealed class VolatileProtectedRecordStore : IProtectedRecordStore, IDisposable
{
    private readonly Lock _gate = new();
    private readonly Dictionary<ProtectedRecordId, RecordValue> _records = [];
    private readonly int _maxItems;
    private readonly long _maxTotalBytes;
    private readonly Action<byte[]>? _onZeroed;
    private bool _disposed;
    private long _totalBytes;

    public VolatileProtectedRecordStore(
        int maxPayloadBytes = 1024 * 1024,
        int maxItems = 4096,
        long maxTotalBytes = 64L * 1024 * 1024)
        : this(maxPayloadBytes, maxItems, maxTotalBytes, null)
    {
    }

    internal VolatileProtectedRecordStore(
        int maxPayloadBytes,
        int maxItems,
        long maxTotalBytes,
        Action<byte[]>? onZeroed)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(maxPayloadBytes, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxItems, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxTotalBytes, maxPayloadBytes);
        MaxPayloadBytes = maxPayloadBytes;
        _maxItems = maxItems;
        _maxTotalBytes = maxTotalBytes;
        _onZeroed = onZeroed;
    }

    public int MaxPayloadBytes { get; }

    public Task PutAsync(
        ProtectedRecordId id,
        string recordKind,
        DateTimeOffset capturedAt,
        StorageResolution resolution,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidatePayload(payload);
        var replacement = new RecordValue(
            recordKind, capturedAt, resolution, payload.ToArray());
        var transferred = false;
        try
        {
            lock (_gate)
            {
                ThrowIfDisposed();
                _records.TryGetValue(id, out var existing);
                EnsureBounds(
                    _records.Count + (existing is null ? 1 : 0),
                    _totalBytes - (existing?.Payload.LongLength ?? 0) + replacement.Payload.LongLength);
                _records[id] = replacement;
                _totalBytes += replacement.Payload.LongLength - (existing?.Payload.LongLength ?? 0);
                transferred = true;
                if (existing is not null)
                    Zero(existing.Payload);
            }
        }
        finally
        {
            if (!transferred)
                Zero(replacement.Payload);
        }
        return Task.CompletedTask;
    }

    public Task<ProtectedRecord?> GetAsync(
        ProtectedRecordId id,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            ThrowIfDisposed();
            return Task.FromResult(_records.TryGetValue(id, out var value)
                ? new ProtectedRecord(
                    id, value.RecordKind, value.CapturedAt, value.Resolution, value.Payload)
                : null);
        }
    }

    public Task<bool> DeleteAsync(
        ProtectedRecordId id,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            ThrowIfDisposed();
            if (!_records.Remove(id, out var value))
                return Task.FromResult(false);
            _totalBytes -= value.Payload.LongLength;
            Zero(value.Payload);
            return Task.FromResult(true);
        }
    }

    public Task<ProtectedSetReplacement> ReplaceSetAsync(
        string idPrefix,
        IEnumerable<ProtectedRecordWrite> records,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(idPrefix);
        ArgumentNullException.ThrowIfNull(records);
        cancellationToken.ThrowIfCancellationRequested();
        var staged = new Dictionary<ProtectedRecordId, RecordValue>();
        long stagedBytes = 0;
        var written = 0;
        var deleted = 0;
        var deletedBytes = 0L;
        var hold = TimeSpan.Zero;
        try
        {
            foreach (var record in records)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!record.Id.Value.StartsWith(idPrefix, StringComparison.Ordinal))
                    throw new ArgumentException("Replacement record id is outside the requested prefix.");
                ValidatePayload(record.Payload);
                if (staged.ContainsKey(record.Id))
                    throw new ArgumentException("Replacement set contains a duplicate record id.");
                if (staged.Count + 1 > _maxItems ||
                    stagedBytes + record.Payload.Length > _maxTotalBytes)
                    throw new InvalidOperationException(
                        "Volatile protected record replacement exceeds capacity.");
                staged.Add(
                    record.Id,
                    new RecordValue(
                        record.RecordKind,
                        record.CapturedAt,
                        record.Resolution,
                        record.Payload.ToArray()));
                stagedBytes += record.Payload.Length;
                written++;
            }

            // This store has no write lock; the equivalent exclusive section is the gate below.
            // It excludes the staging loop above, unlike the SQLite store, because staging here
            // happens outside the lock rather than inside the transaction.
            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
            lock (_gate)
            {
                ThrowIfDisposed();
                var existing = _records.Where(pair =>
                    pair.Key.Value.StartsWith(idPrefix, StringComparison.Ordinal)).ToArray();
                var count = _records.Count - existing.Length + staged.Count;
                var bytes = _totalBytes -
                            existing.Sum(pair => pair.Value.Payload.LongLength) +
                            staged.Sum(pair => pair.Value.Payload.LongLength);
                EnsureBounds(count, bytes);
                foreach (var pair in existing)
                {
                    _records.Remove(pair.Key);
                    Zero(pair.Value.Payload);
                }
                foreach (var pair in staged)
                    _records.Add(pair.Key, pair.Value);
                _totalBytes = bytes;
                deleted = existing.Length;
                deletedBytes = existing.Sum(pair => pair.Value.Payload.LongLength);
                staged.Clear();
            }
            hold = stopwatch.Elapsed;
        }
        finally
        {
            foreach (var value in staged.Values)
                Zero(value.Payload);
        }
        // Nothing is framed on the way in, so stored bytes are the payload bytes.
        return Task.FromResult(new ProtectedSetReplacement(
            deleted, deletedBytes, written, stagedBytes, stagedBytes, hold));
    }

    /// <summary>
    /// Nothing here is on disk and nothing expires -- <see cref="PruneExpiredAsync"/> is a no-op
    /// by design -- so the backlog is always zero and only the in-memory composition is real.
    /// </summary>
    public Task<ProtectedStorageUsage> MeasureUsageAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            ThrowIfDisposed();
            var kinds = _records.Values
                .GroupBy(value => value.RecordKind, StringComparer.Ordinal)
                .Select(group => new ProtectedRecordKindUsage(
                    group.Key, group.Count(), group.Sum(value => value.Payload.LongLength)))
                .OrderByDescending(kind => kind.StoredBytes)
                .ThenBy(kind => kind.RecordKind, StringComparer.Ordinal)
                .ToArray();
            return Task.FromResult(new ProtectedStorageUsage(
                _records.Count, _totalBytes, 0, 0, kinds));
        }
    }

    public Task<int> PruneExpiredAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            ThrowIfDisposed();
            return Task.FromResult(0);
        }
    }

    public Task<IReadOnlyList<ProtectedRecordId>> ListOldestAsync(
        IReadOnlyCollection<string> recordKinds,
        int limit,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(recordKinds);
        ArgumentOutOfRangeException.ThrowIfLessThan(limit, 1);
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            ThrowIfDisposed();
            return Task.FromResult<IReadOnlyList<ProtectedRecordId>>(
                _records
                    .Where(pair => recordKinds.Contains(pair.Value.RecordKind))
                    .OrderBy(pair => pair.Value.CapturedAt)
                    .ThenBy(pair => pair.Key.Value, StringComparer.Ordinal)
                    .Take(limit)
                    .Select(pair => pair.Key)
                    .ToArray());
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
                return;
            _disposed = true;
            foreach (var value in _records.Values)
                Zero(value.Payload);
            _records.Clear();
            _totalBytes = 0;
        }
    }

    private void ValidatePayload(ReadOnlyMemory<byte> payload)
    {
        if (payload.Length > MaxPayloadBytes)
            throw new ArgumentOutOfRangeException(nameof(payload), "Payload exceeds the volatile record bound.");
    }

    private void EnsureBounds(int count, long bytes)
    {
        if (count > _maxItems || bytes > _maxTotalBytes)
            throw new InvalidOperationException("Volatile protected record store capacity is exhausted.");
    }

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);

    private void Zero(byte[] payload)
    {
        CryptographicOperations.ZeroMemory(payload);
        _onZeroed?.Invoke(payload);
    }

    private sealed record RecordValue(
        string RecordKind,
        DateTimeOffset CapturedAt,
        StorageResolution Resolution,
        byte[] Payload);
}
