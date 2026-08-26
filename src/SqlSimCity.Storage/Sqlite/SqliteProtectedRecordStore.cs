using Microsoft.Data.Sqlite;
using System.Security.Cryptography;
using SqlSimCity.Storage;
using SqlSimCity.Storage.Crypto;

namespace SqlSimCity.Storage.Sqlite;

/// <summary>
/// SQLite-backed <see cref="IProtectedRecordStore"/>. SQLite holds the opaque id,
/// record kind, captured timestamp, resolution, and the record envelope, whose
/// payload is stored in the clear. A new connection is
/// opened per operation (each with its own busy timeout), relying on WAL for
/// reader/writer concurrency rather than in-process locking. Loops that read many
/// records should take a <see cref="BeginReadSessionAsync"/> session instead, which
/// amortises that connection setup over the batch without enabling pooling.
/// <see cref="EnsureReadyAsync"/> must succeed before any other member is
/// called; every other member throws <see cref="InvalidOperationException"/>
/// otherwise, which keeps the store fail-closed if a host forgets to await
/// startup initialization.
/// </summary>
public sealed class SqliteProtectedRecordStore : IProtectedRecordStore, IProtectedStorageInitializer, IDisposable
{
    private const string SelectRecordSql =
        "SELECT record_kind, captured_at_unix_ms, resolution, envelope FROM protected_records WHERE id = $id;";

    private readonly string _connectionString;
    private readonly string _databasePath;
    private readonly RetentionOptions _retention;
    private readonly TimeProvider _timeProvider;
    private readonly int _maxRecordKindLength;
    private readonly int _maxPayloadBytes;
    private int _ready;
    private bool _encodingIsUtf8;
    private bool _disposed;

    public int MaxPayloadBytes => _maxPayloadBytes;

    public SqliteProtectedRecordStore(
        string dataDirectory,
        string databaseFileName,
        RetentionOptions retention,
        TimeProvider timeProvider,
        int maxRecordKindLength = ProtectedStorageOptions.DefaultMaxRecordKindLength,
        int maxPayloadBytes = ProtectedStorageOptions.DefaultMaxPayloadBytes)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dataDirectory);
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseFileName);
        ArgumentNullException.ThrowIfNull(retention);
        ArgumentNullException.ThrowIfNull(timeProvider);
        if (maxRecordKindLength is < 1 or > ProtectedStorageOptions.MaximumRecordKindLength)
        {
            throw new ArgumentOutOfRangeException(
                nameof(maxRecordKindLength),
                $"Record-kind length limit must be between 1 and {ProtectedStorageOptions.MaximumRecordKindLength}.");
        }

        if (maxPayloadBytes is < 1 or > ProtectedStorageOptions.MaximumPayloadBytes)
        {
            throw new ArgumentOutOfRangeException(
                nameof(maxPayloadBytes),
                $"Payload size limit must be between 1 and {ProtectedStorageOptions.MaximumPayloadBytes}.");
        }

        Directory.CreateDirectory(dataDirectory);
        var databasePath = Path.Combine(dataDirectory, databaseFileName);
        _databasePath = databasePath;
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            // Pooling keeps a native handle open after the C# wrapper is disposed,
            // which holds Windows file locks past the point tests (and operators)
            // expect the file to be free. This store isn't a request hot path.
            Pooling = false,
        }.ToString();
        _retention = retention;
        _timeProvider = timeProvider;
        _maxRecordKindLength = maxRecordKindLength;
        _maxPayloadBytes = maxPayloadBytes;
    }

    public async Task EnsureReadyAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await SqliteSchema.EnsureReadyAsync(connection, _timeProvider, cancellationToken);
        _encodingIsUtf8 = await ReadEncodingIsUtf8Async(connection, cancellationToken);
        Volatile.Write(ref _ready, 1);
    }

    public async Task PutAsync(
        ProtectedRecordId id,
        string recordKind,
        DateTimeOffset capturedAt,
        StorageResolution resolution,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        ArgumentException.ThrowIfNullOrWhiteSpace(recordKind);
        if (recordKind.Length > _maxRecordKindLength)
        {
            throw new ArgumentException(
                $"Record kind must be {_maxRecordKindLength} characters or fewer.", nameof(recordKind));
        }

        if (payload.Length > _maxPayloadBytes)
        {
            throw new ArgumentException(
                $"Payload must be {_maxPayloadBytes} bytes or fewer.", nameof(payload));
        }

        var envelope = EnvelopeCodec.Wrap(recordKind, id.Value, payload.Span);

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO protected_records (id, record_kind, captured_at_unix_ms, resolution, envelope, stored_at_unix_ms)
            VALUES ($id, $kind, $capturedAt, $resolution, $envelope, $storedAt)
            ON CONFLICT(id) DO UPDATE SET
                record_kind = excluded.record_kind,
                captured_at_unix_ms = excluded.captured_at_unix_ms,
                resolution = excluded.resolution,
                envelope = excluded.envelope,
                stored_at_unix_ms = excluded.stored_at_unix_ms;
            """;
        command.Parameters.AddWithValue("$id", id.Value);
        command.Parameters.AddWithValue("$kind", recordKind);
        command.Parameters.AddWithValue("$capturedAt", capturedAt.ToUnixTimeMilliseconds());
        command.Parameters.AddWithValue("$resolution", resolution.ToString());
        command.Parameters.AddWithValue("$envelope", envelope);
        command.Parameters.AddWithValue("$storedAt", _timeProvider.GetUtcNow().ToUnixTimeMilliseconds());
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<ProtectedRecord?> GetAsync(ProtectedRecordId id, CancellationToken cancellationToken = default)
    {
        EnsureInitialized();

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = SelectRecordSql;
        command.Parameters.AddWithValue("$id", id.Value);
        return await ReadRecordAsync(command, id, cancellationToken);
    }

    /// <summary>
    /// Opens one connection with one prepared select and serves the batch from it. The
    /// caller decides the batch boundary, so the handle lifetime stays explicit -- unlike
    /// connection pooling, which keeps a native handle (and on Windows a file lock) alive
    /// after the wrapper is disposed.
    /// </summary>
    public async Task<IProtectedRecordReadSession> BeginReadSessionAsync(
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        var connection = await OpenConnectionAsync(cancellationToken);
        try
        {
            return new SqliteReadSession(connection);
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    private static async Task<ProtectedRecord?> ReadRecordAsync(
        SqliteCommand command, ProtectedRecordId id, CancellationToken cancellationToken)
    {
        string recordKind;
        long capturedAtUnixMs;
        StorageResolution resolution;
        byte[] envelope;

        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            if (!await reader.ReadAsync(cancellationToken))
            {
                return null;
            }

            recordKind = reader.GetString(0);
            capturedAtUnixMs = reader.GetInt64(1);
            resolution = Enum.Parse<StorageResolution>(reader.GetString(2));
            envelope = (byte[])reader["envelope"];
        }

        var plaintext = EnvelopeCodec.Unwrap(recordKind, id.Value, envelope);
        try
        {
            return new ProtectedRecord(
                id, recordKind, DateTimeOffset.FromUnixTimeMilliseconds(capturedAtUnixMs), resolution, plaintext);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    public async Task<bool> DeleteAsync(ProtectedRecordId id, CancellationToken cancellationToken = default)
    {
        EnsureInitialized();

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM protected_records WHERE id = $id;";
        command.Parameters.AddWithValue("$id", id.Value);
        var affected = await command.ExecuteNonQueryAsync(cancellationToken);
        return affected > 0;
    }

    public async Task<ProtectedSetReplacement> ReplaceSetAsync(
        string idPrefix,
        IEnumerable<ProtectedRecordWrite> records,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        ArgumentException.ThrowIfNullOrWhiteSpace(idPrefix);
        ArgumentNullException.ThrowIfNull(records);

        var deleted = 0;
        var deletedBytes = 0L;
        var written = 0;
        var payloadBytes = 0L;
        var storedBytes = 0L;
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction =
            (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);
        // SQLite takes the write lock at the first write statement, not at BEGIN, so the hold
        // starts here rather than above. It runs to the commit and therefore covers the caller's
        // own serialization work: `records` is lazy, so every record it yields is built while
        // other writers are already waiting. That is the cost being reported, not an artefact.
        var writeLockHold = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            // Inside the transaction, so what is measured is exactly what the delete then removes.
            // It is the same seek the delete performs and reads only row headers, but it is real
            // work added to a publish, and the byte figure is what makes the churn quantifiable
            // rather than inferred.
            await using (var size = connection.CreateCommand())
            {
                size.Transaction = transaction;
                SqlitePrefixRange.ConfigureSize(size, idPrefix, _encodingIsUtf8);
                await using var reader = await size.ExecuteReaderAsync(cancellationToken);
                if (await reader.ReadAsync(cancellationToken))
                    deletedBytes = reader.GetInt64(1);
            }

            await using (var delete = connection.CreateCommand())
            {
                delete.Transaction = transaction;
                // A half-open range over the primary key seeks the index; substr() on the
                // indexed column cannot, so it scanned every row on every slot replacement --
                // and a normalized plan is stored through this path too, up to 96 times per
                // cold database-city page. Prefixes with no provably equivalent bound keep
                // the exact predicate.
                SqlitePrefixRange.ConfigureDelete(delete, idPrefix, _encodingIsUtf8);
                deleted = await delete.ExecuteNonQueryAsync(cancellationToken);
            }

            await using var put = connection.CreateCommand();
            put.Transaction = transaction;
            put.CommandText = """
                INSERT INTO protected_records (id, record_kind, captured_at_unix_ms, resolution, envelope, stored_at_unix_ms)
                VALUES ($id, $kind, $capturedAt, $resolution, $envelope, $storedAt);
                """;
            var idParameter = put.Parameters.Add("$id", SqliteType.Text);
            var kindParameter = put.Parameters.Add("$kind", SqliteType.Text);
            var capturedParameter = put.Parameters.Add("$capturedAt", SqliteType.Integer);
            var resolutionParameter = put.Parameters.Add("$resolution", SqliteType.Text);
            var envelopeParameter = put.Parameters.Add("$envelope", SqliteType.Blob);
            var storedParameter = put.Parameters.Add("$storedAt", SqliteType.Integer);

            foreach (var record in records)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ValidateWrite(record.RecordKind, record.Payload);
                if (!record.Id.Value.StartsWith(idPrefix, StringComparison.Ordinal))
                    throw new ArgumentException("Every replacement record id must start with the set prefix.", nameof(records));

                var envelope = EnvelopeCodec.Wrap(
                    record.RecordKind, record.Id.Value, record.Payload.Span);
                try
                {
                    idParameter.Value = record.Id.Value;
                    kindParameter.Value = record.RecordKind;
                    capturedParameter.Value = record.CapturedAt.ToUnixTimeMilliseconds();
                    resolutionParameter.Value = record.Resolution.ToString();
                    envelopeParameter.Value = envelope;
                    storedParameter.Value = _timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
                    await put.ExecuteNonQueryAsync(cancellationToken);
                    written++;
                    payloadBytes += record.Payload.Length;
                    storedBytes += envelope.Length;
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(envelope);
                }
            }
            await transaction.CommitAsync(cancellationToken);
            writeLockHold.Stop();
            return new ProtectedSetReplacement(
                deleted, deletedBytes, written, payloadBytes, storedBytes, writeLockHold.Elapsed);
        }
        catch
        {
            await transaction.RollbackAsync(CancellationToken.None);
            throw;
        }
    }

    /// <summary>
    /// One grouped pass for composition plus one indexed count for the backlog. The grouped pass
    /// is a full table scan -- SQLite answers <c>length(blob)</c> from the row header without
    /// loading overflow pages, but it still visits every row -- so this belongs on a periodic
    /// cadence, not in a request. The backlog count seeks
    /// <c>idx_protected_records_resolution_captured_at</c> and matches
    /// <see cref="PruneExpiredAsync"/>'s predicate exactly, so the two cannot drift.
    /// </summary>
    public async Task<ProtectedStorageUsage> MeasureUsageAsync(CancellationToken cancellationToken = default)
    {
        EnsureInitialized();

        await using var connection = await OpenConnectionAsync(cancellationToken);
        var kinds = new List<ProtectedRecordKindUsage>();
        var recordCount = 0L;
        var storedBytes = 0L;
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                SELECT record_kind, COUNT(*), COALESCE(SUM(length(envelope)), 0)
                FROM protected_records
                GROUP BY record_kind
                ORDER BY 3 DESC, 1 ASC;
                """;
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var kindBytes = reader.GetInt64(2);
                var kindCount = reader.GetInt64(1);
                kinds.Add(new ProtectedRecordKindUsage(reader.GetString(0), kindCount, kindBytes));
                recordCount += kindCount;
                storedBytes += kindBytes;
            }
        }

        var now = _timeProvider.GetUtcNow();
        long expired;
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                SELECT COUNT(*) FROM protected_records
                WHERE (resolution = 'Detail' AND captured_at_unix_ms < $detailCutoff)
                   OR (resolution = 'HourlyRollup' AND captured_at_unix_ms < $rollupCutoff);
                """;
            command.Parameters.AddWithValue(
                "$detailCutoff", now.Subtract(_retention.DetailRetention).ToUnixTimeMilliseconds());
            command.Parameters.AddWithValue(
                "$rollupCutoff", now.Subtract(_retention.HourlyRollupRetention).ToUnixTimeMilliseconds());
            expired = Convert.ToInt64(
                await command.ExecuteScalarAsync(cancellationToken),
                System.Globalization.CultureInfo.InvariantCulture);
        }

        return new ProtectedStorageUsage(recordCount, storedBytes, MeasureOnDiskBytes(), expired, kinds);
    }

    /// <summary>
    /// The database file plus its write-ahead log and shared-memory index. WAL is counted because
    /// it is disk an operator has actually lost until a checkpoint, and a store written in large
    /// transactions can carry a WAL comparable to the database itself.
    /// </summary>
    private long MeasureOnDiskBytes()
    {
        var total = 0L;
        foreach (var suffix in new[] { "", "-wal", "-shm" })
        {
            var info = new FileInfo(_databasePath + suffix);
            // Racing a checkpoint that removes the WAL is normal, not an error worth failing on.
            if (info.Exists) total += info.Length;
        }
        return total;
    }

    public async Task<IReadOnlyList<ProtectedRecordId>> ListOldestAsync(
        IReadOnlyCollection<string> recordKinds,
        int limit,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        ArgumentNullException.ThrowIfNull(recordKinds);
        ArgumentOutOfRangeException.ThrowIfLessThan(limit, 1);
        if (recordKinds.Count == 0) return [];

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        var parameterNames = new string[recordKinds.Count];
        var index = 0;
        foreach (var kind in recordKinds)
        {
            parameterNames[index] = $"$kind{index}";
            command.Parameters.AddWithValue(parameterNames[index], kind);
            index++;
        }

        // Ordered by id as well so the sequence is total: a batch of records captured in the same
        // millisecond -- which every record of one hydrated plan is -- must not be returned in a
        // different order on each call, or repeated eviction passes would make no progress.
        command.CommandText =
            $"SELECT id FROM protected_records WHERE record_kind IN ({string.Join(",", parameterNames)}) " +
            "ORDER BY captured_at_unix_ms ASC, id ASC LIMIT $limit;";
        command.Parameters.AddWithValue("$limit", limit);
        var ids = new List<ProtectedRecordId>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            ids.Add(new ProtectedRecordId(reader.GetString(0)));
        return ids;
    }

    public async Task<int> PruneExpiredAsync(CancellationToken cancellationToken = default)
    {
        EnsureInitialized();

        var now = _timeProvider.GetUtcNow();
        var detailCutoffUnixMs = now.Subtract(_retention.DetailRetention).ToUnixTimeMilliseconds();
        var rollupCutoffUnixMs = now.Subtract(_retention.HourlyRollupRetention).ToUnixTimeMilliseconds();
        var batchSize = _retention.PruneBatchSize;
        await using var connection = await OpenConnectionAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();

        var idsToDelete = new List<string>();
        await using (var selectCommand = connection.CreateCommand())
        {
            selectCommand.CommandText = """
                SELECT id FROM protected_records
                WHERE (resolution = 'Detail' AND captured_at_unix_ms < $detailCutoff)
                   OR (resolution = 'HourlyRollup' AND captured_at_unix_ms < $rollupCutoff)
                LIMIT $batchSize;
                """;
            selectCommand.Parameters.AddWithValue("$detailCutoff", detailCutoffUnixMs);
            selectCommand.Parameters.AddWithValue("$rollupCutoff", rollupCutoffUnixMs);
            selectCommand.Parameters.AddWithValue("$batchSize", batchSize);
            await using var reader = await selectCommand.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                idsToDelete.Add(reader.GetString(0));
            }
        }

        if (idsToDelete.Count == 0)
        {
            return 0;
        }

        await using var deleteCommand = connection.CreateCommand();
        var parameterNames = new string[idsToDelete.Count];
        for (var i = 0; i < idsToDelete.Count; i++)
        {
            var parameterName = $"$id{i}";
            parameterNames[i] = parameterName;
            deleteCommand.Parameters.AddWithValue(parameterName, idsToDelete[i]);
        }

        deleteCommand.CommandText =
            $"DELETE FROM protected_records WHERE id IN ({string.Join(",", parameterNames)});";
        return await deleteCommand.ExecuteNonQueryAsync(cancellationToken);
    }

    public void Dispose()
    {
        _disposed = true;
    }

    private void EnsureInitialized()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (Volatile.Read(ref _ready) == 0)
        {
            throw new InvalidOperationException(
                "Protected storage has not completed EnsureReadyAsync. Call it during startup before use.");
        }
    }

    private void ValidateWrite(string recordKind, ReadOnlyMemory<byte> payload)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(recordKind);
        if (recordKind.Length > _maxRecordKindLength)
            throw new ArgumentException(
                $"Record kind must be {_maxRecordKindLength} characters or fewer.", nameof(recordKind));
        if (payload.Length > _maxPayloadBytes)
            throw new ArgumentException(
                $"Payload must be {_maxPayloadBytes} bytes or fewer.", nameof(payload));
    }

    private async Task<SqliteConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;";
        await command.ExecuteNonQueryAsync(cancellationToken);
        return connection;
    }

    /// <summary>
    /// Reports whether BINARY collation compares UTF-8 bytes on this database. Stores this
    /// code creates are UTF-8, but the encoding is fixed when a file is first written, so a
    /// file created elsewhere can be UTF-16 -- where memcmp also orders the high byte of an
    /// ASCII character and a prefix range would select ids that do not share the prefix.
    /// </summary>
    private static async Task<bool> ReadEncodingIsUtf8Async(
        SqliteConnection connection, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA encoding;";
        var value = await command.ExecuteScalarAsync(cancellationToken);
        return value is string encoding &&
            encoding.Equals("UTF-8", StringComparison.OrdinalIgnoreCase);
    }

    private sealed class SqliteReadSession : IProtectedRecordReadSession
    {
        private readonly SqliteConnection _connection;
        private readonly SqliteCommand _command;
        private readonly SqliteParameter _id;
        private readonly SemaphoreSlim _gate = new(1, 1);

        public SqliteReadSession(SqliteConnection connection)
        {
            _connection = connection;
            _command = connection.CreateCommand();
            _command.CommandText = SelectRecordSql;
            _id = _command.Parameters.Add("$id", SqliteType.Text);
            _command.Prepare();
        }

        public async Task<ProtectedRecord?> GetAsync(
            ProtectedRecordId id, CancellationToken cancellationToken = default)
        {
            // One connection cannot run two commands at once. The gate makes an accidental
            // parallel read wait rather than tear the shared reader.
            await _gate.WaitAsync(cancellationToken);
            try
            {
                _id.Value = id.Value;
                return await ReadRecordAsync(_command, id, cancellationToken);
            }
            finally
            {
                _gate.Release();
            }
        }

        public async ValueTask DisposeAsync()
        {
            await _command.DisposeAsync();
            await _connection.DisposeAsync();
            _gate.Dispose();
        }
    }
}
