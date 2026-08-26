using System.Globalization;
using System.Text.RegularExpressions;
using SqlSimCity.Edge.Envelope;

namespace SqlSimCity.Edge.Spool;

/// <summary>A sealed batch read back from the spool, ready to deliver.</summary>
public sealed record SpooledBatch(string FileName, string BatchId, ObservationBatchV1 Batch);

/// <summary>
/// A bounded, on-disk, AES-256-GCM-encrypted FIFO spool for batches that could not be delivered
/// immediately. Guarantees:
/// <list type="bullet">
/// <item>Atomic writes: a batch is written to a temp file and renamed into place, so a crash never
/// leaves a partially written spool file visible.</item>
/// <item>Single writer: all mutations are serialized under one lock.</item>
/// <item>Explicit bounds: exceeding <see cref="SpoolOptions.MaxBytes"/> or
/// <see cref="SpoolOptions.MaxItems"/> yields <see cref="SpoolEnqueueOutcome.RejectedBackpressure"/>
/// and a paused status — never a silent drop.</item>
/// <item>Ordered resume: files sort by an embedded monotonic prefix, so delivery resumes in
/// production order after a restart.</item>
/// <item>No traversal or special files: only regular files whose names match the strict spool
/// pattern are ever read, and batch ids are validated to a safe token before they touch the path.</item>
/// <item>Cheap accounting: occupancy is scanned once, then maintained from this instance's own
/// mutations, so a per-cycle status or enqueue does not re-enumerate and re-stat the directory. A
/// restart or a mutation that fails part-way discards the tally and rescans.</item>
/// </list>
/// </summary>
public sealed partial class EncryptedSpool
{
    private readonly SpoolOptions _options;
    private readonly SpoolKey _key;
    private readonly TimeProvider _timeProvider;
    private readonly Lock _gate = new();
    private long _sequence;
    private long _droppedByAge;
    private bool _paused;
    private (int Count, long Bytes)? _occupancy;

    public EncryptedSpool(SpoolOptions options, SpoolKey key, TimeProvider? timeProvider = null)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _options.Validate();
        _key = key ?? throw new ArgumentNullException(nameof(key));
        _timeProvider = timeProvider ?? TimeProvider.System;
        Directory.CreateDirectory(_options.DataDirectory);
    }

    [GeneratedRegex(@"^\d{13}-\d{6}-[A-Za-z0-9_-]{1,128}\.spool$")]
    private static partial Regex SpoolFilePattern();

    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,128}$")]
    private static partial Regex SafeBatchIdPattern();

    /// <summary>Seals and durably enqueues <paramref name="batch"/>, or reports backpressure if a bound is hit.</summary>
    public SpoolEnqueueOutcome Enqueue(ObservationBatchV1 batch) => Enqueue(batch, out _);

    /// <summary>
    /// As <see cref="Enqueue(ObservationBatchV1)"/> but returns the written file name on success, so a
    /// caller performing a multi-part write (a 413 split) can roll back an already-written part if a
    /// later part hits backpressure — preventing partial loss or duplication.
    /// </summary>
    public SpoolEnqueueOutcome Enqueue(ObservationBatchV1 batch, out string? fileName)
    {
        ArgumentNullException.ThrowIfNull(batch);
        fileName = null;
        if (!SafeBatchIdPattern().IsMatch(batch.BatchId))
            throw new ArgumentException("Batch id is not a safe spool token.", nameof(batch));

        var plaintext = EdgeJson.SerializeToUtf8Bytes(batch);
        var sealed_ = SealedSpoolCodec.Seal(_key, batch.BatchId, plaintext);

        lock (_gate)
        {
            var (count, bytes) = MeasureLocked();
            if (count + 1 > _options.MaxItems || bytes + sealed_.Length > _options.MaxBytes)
            {
                _paused = true;
                return SpoolEnqueueOutcome.RejectedBackpressure;
            }

            var millis = _timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
            var ordinal = Interlocked.Increment(ref _sequence) % 1_000_000;
            var name = $"{millis:D13}-{ordinal:D6}-{batch.BatchId}.spool";
            var finalPath = Path.Combine(_options.DataDirectory, name);
            var tempPath = Path.Combine(_options.DataDirectory, $".tmp-{Guid.NewGuid():N}");

            // Any failure between here and the tally update leaves the directory as the source of
            // truth; discard the cached occupancy so the next measure rescans.
            _occupancy = null;
            using (var stream = new FileStream(tempPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(sealed_, 0, sealed_.Length);
                stream.Flush(flushToDisk: true);
            }

            File.Move(tempPath, finalPath, overwrite: false);
            _occupancy = (count + 1, bytes + sealed_.Length);
            _paused = false;
            fileName = name;
            return SpoolEnqueueOutcome.Accepted;
        }
    }

    /// <summary>Opens the oldest queued batch without removing it, or <c>null</c> if the spool is empty.</summary>
    public SpooledBatch? PeekOldest()
    {
        lock (_gate)
        {
            var oldest = ListValidFilesLocked().FirstOrDefault();
            if (oldest is null)
                return null;

            var fileName = Path.GetFileName(oldest);
            var batchId = ExtractBatchId(fileName);
            var sealed_ = File.ReadAllBytes(oldest);
            var plaintext = SealedSpoolCodec.Open(_key, batchId, sealed_);
            var batch = System.Text.Json.JsonSerializer.Deserialize<ObservationBatchV1>(plaintext, EdgeJson.Options)
                ?? throw new SpoolIntegrityException("Sealed spool file decoded to a null batch.");
            return new SpooledBatch(fileName, batchId, batch);
        }
    }

    /// <summary>Deletes exactly the acknowledged file. A no-op if it was already removed.</summary>
    public void Acknowledge(string fileName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(fileName);
        if (!SpoolFilePattern().IsMatch(fileName))
            throw new ArgumentException("Refusing to acknowledge a file name outside the spool pattern.", nameof(fileName));

        lock (_gate)
        {
            var path = Path.Combine(_options.DataDirectory, fileName);
            if (!File.Exists(path))
                return;

            var length = TryFileLength(path);
            File.Delete(path);
            Deduct(length);
        }
    }

    /// <summary>Drops queued batches older than <see cref="SpoolOptions.MaxAge"/>, returning how many were dropped.</summary>
    public long PruneExpired()
    {
        lock (_gate)
        {
            var cutoff = _timeProvider.GetUtcNow().ToUnixTimeMilliseconds() - (long)_options.MaxAge.TotalMilliseconds;
            long dropped = 0;
            foreach (var path in ListValidFilesLocked())
            {
                var millis = ParsePrefixMillis(Path.GetFileName(path));
                if (millis < cutoff)
                {
                    var length = TryFileLength(path);
                    File.Delete(path);
                    Deduct(length);
                    dropped++;
                }
            }

            _droppedByAge += dropped;
            return dropped;
        }
    }

    public SpoolStatus GetStatus()
    {
        lock (_gate)
        {
            var (count, bytes) = MeasureLocked();
            return new SpoolStatus(count, bytes, _paused, _droppedByAge);
        }
    }

    /// <summary>
    /// Current occupancy, scanned once and then maintained from this instance's own mutations. The
    /// directory stays the source of truth: a fresh instance (a restart) rescans, and so does any
    /// mutation that could not account for itself.
    /// </summary>
    private (int Count, long Bytes) MeasureLocked()
    {
        if (_occupancy is { } cached)
            return cached;

        var count = 0;
        long bytes = 0;
        foreach (var path in ListValidFilesLocked())
        {
            var length = TryFileLength(path);
            if (length is null)
                continue; // Vanished between enumeration and stat; it is no longer occupancy.
            count++;
            bytes += length.Value;
        }

        _occupancy = (count, bytes);
        return _occupancy.Value;
    }

    /// <summary>Removes one accounted-for file from the tally, or discards it if the size is unknown.</summary>
    private void Deduct(long? length)
    {
        if (_occupancy is not { } cached || length is null)
        {
            _occupancy = null;
            return;
        }

        _occupancy = (Math.Max(cached.Count - 1, 0), Math.Max(cached.Bytes - length.Value, 0));
    }

    private static long? TryFileLength(string path)
    {
        try
        {
            return new FileInfo(path).Length;
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException or IOException)
        {
            return null;
        }
    }

    private IEnumerable<string> ListValidFilesLocked()
    {
        if (!Directory.Exists(_options.DataDirectory))
            return Enumerable.Empty<string>();

        return Directory.EnumerateFiles(_options.DataDirectory)
            .Where(path =>
            {
                var name = Path.GetFileName(path);
                if (!SpoolFilePattern().IsMatch(name))
                    return false;
                var attributes = File.GetAttributes(path);
                // Reject directories, symlinks/junctions, and other non-regular entries.
                return !attributes.HasFlag(FileAttributes.Directory)
                    && !attributes.HasFlag(FileAttributes.ReparsePoint);
            })
            .OrderBy(Path.GetFileName, StringComparer.Ordinal);
    }

    private static string ExtractBatchId(string fileName)
    {
        // Pattern: 13-digit millis, '-', 6-digit ordinal, '-', batchId, ".spool".
        var core = fileName[..^".spool".Length];
        return core[21..];
    }

    private static long ParsePrefixMillis(string fileName)
        => long.Parse(fileName.AsSpan(0, 13), NumberStyles.Integer, CultureInfo.InvariantCulture);
}
