using Microsoft.Extensions.Time.Testing;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Spool;

namespace SqlSimCity.Edge.Tests;

public sealed class EncryptedSpoolTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sqlsimcity-spool-" + Guid.NewGuid().ToString("N"));

    private static SpoolKey Key(uint version = 1)
    {
        var bytes = new byte[32];
        for (var i = 0; i < bytes.Length; i++)
            bytes[i] = (byte)(i + version);
        return new SpoolKey(version, bytes);
    }

    private SpoolOptions Options(long maxBytes = 1_000_000, int maxItems = 100, TimeSpan? maxAge = null) => new()
    {
        DataDirectory = _dir,
        MaxBytes = maxBytes,
        MaxItems = maxItems,
        MaxAge = maxAge ?? TimeSpan.FromHours(1),
    };

    [Fact]
    public void Enqueue_peek_acknowledge_round_trip()
    {
        using var key = Key();
        var spool = new EncryptedSpool(Options(), key);
        var batch = EdgeTestSupport.SampleBatch(sequence: 7);

        Assert.Equal(SpoolEnqueueOutcome.Accepted, spool.Enqueue(batch));
        var peeked = spool.PeekOldest();
        Assert.NotNull(peeked);
        Assert.Equal(batch.BatchId, peeked!.Batch.BatchId);
        Assert.Equal(7, peeked.Batch.Envelopes[0].Sequence);

        spool.Acknowledge(peeked.FileName);
        Assert.Null(spool.PeekOldest());
    }

    [Fact]
    public void Delivery_order_is_fifo()
    {
        using var key = Key();
        var time = new FakeTimeProvider(DateTimeOffset.UnixEpoch);
        var spool = new EncryptedSpool(Options(), key, time);
        for (var i = 0; i < 5; i++)
        {
            spool.Enqueue(EdgeTestSupport.SampleBatch(sequence: i));
            time.Advance(TimeSpan.FromMilliseconds(5));
        }

        for (var i = 0; i < 5; i++)
        {
            var peeked = spool.PeekOldest();
            Assert.Equal(i, peeked!.Batch.Envelopes[0].Sequence);
            spool.Acknowledge(peeked.FileName);
        }
    }

    [Fact]
    public void Item_bound_applies_backpressure()
    {
        using var key = Key();
        var spool = new EncryptedSpool(Options(maxItems: 2), key);
        Assert.Equal(SpoolEnqueueOutcome.Accepted, spool.Enqueue(EdgeTestSupport.SampleBatch(sequence: 1)));
        Assert.Equal(SpoolEnqueueOutcome.Accepted, spool.Enqueue(EdgeTestSupport.SampleBatch(sequence: 2)));
        Assert.Equal(SpoolEnqueueOutcome.RejectedBackpressure, spool.Enqueue(EdgeTestSupport.SampleBatch(sequence: 3)));
        Assert.True(spool.GetStatus().Paused);
        Assert.Equal(2, spool.GetStatus().ItemCount);
    }

    [Fact]
    public void Byte_bound_applies_backpressure()
    {
        using var key = Key();
        var spool = new EncryptedSpool(Options(maxBytes: 4096), key);
        var outcomes = new List<SpoolEnqueueOutcome>();
        for (var i = 0; i < 50; i++)
            outcomes.Add(spool.Enqueue(EdgeTestSupport.SampleBatch(sequence: i)));
        Assert.Contains(SpoolEnqueueOutcome.RejectedBackpressure, outcomes);
        Assert.True(spool.GetStatus().ByteCount <= 4096);
    }

    [Fact]
    public void Prune_drops_expired_and_records_count()
    {
        using var key = Key();
        var time = new FakeTimeProvider(DateTimeOffset.UnixEpoch);
        var spool = new EncryptedSpool(Options(maxAge: TimeSpan.FromMinutes(10)), key, time);
        spool.Enqueue(EdgeTestSupport.SampleBatch(sequence: 1));
        time.Advance(TimeSpan.FromMinutes(20));
        spool.Enqueue(EdgeTestSupport.SampleBatch(sequence: 2));

        var dropped = spool.PruneExpired();
        Assert.Equal(1, dropped);
        Assert.Equal(1, spool.GetStatus().DroppedByAge);
        Assert.Equal(2, spool.PeekOldest()!.Batch.Envelopes[0].Sequence);
    }

    [Fact]
    public void Resume_after_restart_reads_existing_files()
    {
        using var key = Key();
        var batch = EdgeTestSupport.SampleBatch(sequence: 99);
        {
            var spool = new EncryptedSpool(Options(), key);
            spool.Enqueue(batch);
        }

        using var key2 = Key();
        var resumed = new EncryptedSpool(Options(), key2);
        Assert.Equal(batch.BatchId, resumed.PeekOldest()!.Batch.BatchId);
    }

    [Fact]
    public void Wrong_key_fails_closed()
    {
        var batch = EdgeTestSupport.SampleBatch();
        using (var key = Key(1))
        {
            var spool = new EncryptedSpool(Options(), key);
            spool.Enqueue(batch);
        }

        using var wrong = Key(2); // different version and bytes
        var reopened = new EncryptedSpool(Options(), wrong);
        Assert.Throws<SpoolIntegrityException>(() => reopened.PeekOldest());
    }

    [Fact]
    public void Tampered_file_fails_authentication()
    {
        using var key = Key();
        var spool = new EncryptedSpool(Options(), key);
        spool.Enqueue(EdgeTestSupport.SampleBatch());

        var file = Directory.EnumerateFiles(_dir).First(f => f.EndsWith(".spool", StringComparison.Ordinal));
        var bytes = File.ReadAllBytes(file);
        bytes[^1] ^= 0xFF;
        File.WriteAllBytes(file, bytes);

        Assert.Throws<SpoolIntegrityException>(() => spool.PeekOldest());
    }

    [Fact]
    public void Status_accounting_tracks_enqueue_acknowledge_and_prune()
    {
        using var key = Key();
        var time = new FakeTimeProvider(DateTimeOffset.UnixEpoch);
        var spool = new EncryptedSpool(Options(maxAge: TimeSpan.FromMinutes(10)), key, time);
        Assert.Equal(0, spool.GetStatus().ItemCount);
        Assert.Equal(0, spool.GetStatus().ByteCount);

        spool.Enqueue(EdgeTestSupport.SampleBatch(sequence: 1));
        time.Advance(TimeSpan.FromMinutes(20));
        spool.Enqueue(EdgeTestSupport.SampleBatch(sequence: 2));

        var afterEnqueue = spool.GetStatus();
        Assert.Equal(2, afterEnqueue.ItemCount);
        Assert.Equal(OnDiskBytes(), afterEnqueue.ByteCount);

        Assert.Equal(1, spool.PruneExpired());
        var afterPrune = spool.GetStatus();
        Assert.Equal(1, afterPrune.ItemCount);
        Assert.Equal(OnDiskBytes(), afterPrune.ByteCount);

        spool.Acknowledge(spool.PeekOldest()!.FileName);
        var afterAcknowledge = spool.GetStatus();
        Assert.Equal(0, afterAcknowledge.ItemCount);
        Assert.Equal(0, afterAcknowledge.ByteCount);
        Assert.Equal(OnDiskBytes(), afterAcknowledge.ByteCount);
    }

    [Fact]
    public void Status_accounting_reflects_files_written_by_a_previous_process()
    {
        using var key = Key();
        {
            var first = new EncryptedSpool(Options(), key);
            first.Enqueue(EdgeTestSupport.SampleBatch(sequence: 1));
            first.Enqueue(EdgeTestSupport.SampleBatch(sequence: 2));
        }

        // A restart must not trust a stale tally: the directory is the source of truth.
        using var resumed = Key();
        var status = new EncryptedSpool(Options(), resumed).GetStatus();
        Assert.Equal(2, status.ItemCount);
        Assert.Equal(OnDiskBytes(), status.ByteCount);
    }

    [Fact]
    public void Bounds_still_apply_to_a_spool_resumed_from_disk()
    {
        using var key = Key();
        {
            var first = new EncryptedSpool(Options(maxItems: 2), key);
            Assert.Equal(SpoolEnqueueOutcome.Accepted, first.Enqueue(EdgeTestSupport.SampleBatch(sequence: 1)));
            Assert.Equal(SpoolEnqueueOutcome.Accepted, first.Enqueue(EdgeTestSupport.SampleBatch(sequence: 2)));
        }

        using var resumedKey = Key();
        var resumed = new EncryptedSpool(Options(maxItems: 2), resumedKey);
        Assert.Equal(
            SpoolEnqueueOutcome.RejectedBackpressure,
            resumed.Enqueue(EdgeTestSupport.SampleBatch(sequence: 3)));
        Assert.Equal(2, resumed.GetStatus().ItemCount);
    }

    /// <summary>Ground truth read straight off the file system, independent of the spool's own tally.</summary>
    private long OnDiskBytes() =>
        Directory.Exists(_dir)
            ? Directory.EnumerateFiles(_dir, "*.spool").Sum(path => new FileInfo(path).Length)
            : 0;

    public void Dispose()
    {
        if (Directory.Exists(_dir))
            Directory.Delete(_dir, recursive: true);
    }
}
