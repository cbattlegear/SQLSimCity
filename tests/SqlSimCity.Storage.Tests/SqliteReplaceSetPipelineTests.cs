using System.Text;
using SqlSimCity.Storage.Sqlite;

namespace SqlSimCity.Storage.Tests;

/// <summary>
/// Pins how <see cref="SqliteProtectedRecordStore.ReplaceSetAsync"/> divides the work of a
/// replacement between preparing records and writing them.
///
/// Issue #98 measured the Query Store publish holding the storage write lock for 97-98% of its
/// own duration, which meant nearly everything a publish did -- serializing every family to JSON,
/// framing every envelope -- happened with other writers queued behind it. None of that depends
/// on the transaction, so preparation now runs on a producer task feeding the writer bounded
/// batches. These tests fix the properties that arrangement has to keep, none of them by timing:
/// a timing assertion on a shared CI runner measures the runner.
/// </summary>
public sealed class SqliteReplaceSetPipelineTests : IDisposable
{
    private readonly string _directory =
        Path.Combine(Path.GetTempPath(), "sqlsimcity-replace-pipeline", Guid.NewGuid().ToString("N"));

    private static readonly DateTimeOffset Captured = new(2026, 8, 20, 9, 0, 0, TimeSpan.Zero);

    public void Dispose()
    {
        if (!Directory.Exists(_directory)) return;
        try
        {
            Directory.Delete(_directory, recursive: true);
        }
        catch (IOException)
        {
            // A lingering SQLite handle can transiently hold the file open on Windows.
        }
    }

    private SqliteProtectedRecordStore NewStore(TimeProvider? timeProvider = null) =>
        new(_directory, "history.db", new RetentionOptions(), timeProvider ?? TimeProvider.System);

    private static ProtectedRecordWrite Write(string id, int payloadBytes) =>
        new(new ProtectedRecordId(id), "kind", Captured, StorageResolution.Detail,
            Encoding.UTF8.GetBytes(new string('x', payloadBytes)));

    [Fact]
    public async Task NothingIsSerializedAfterTheTransactionHasStartedWriting()
    {
        // The clock is read once per insert and nowhere else in a replacement, so it counts the
        // rows already written at the moment the sequence is asked for its next record.
        var clock = new CountingTimeProvider(Captured);
        using var store = NewStore(clock);
        await store.EnsureReadyAsync();
        var writtenWhenAsked = new List<int>();

        // Eight small records: far below the batch caps, so the whole set is one batch and the
        // writer cannot have started before the last of them was prepared.
        IEnumerable<ProtectedRecordWrite> Sequence()
        {
            for (var index = 0; index < 8; index++)
            {
                writtenWhenAsked.Add(clock.Reads);
                yield return Write($"set:{index}", 512);
            }
        }

        clock.ResetReads();
        var replacement = await store.ReplaceSetAsync("set:", Sequence());

        Assert.Equal(8, replacement.RecordsWritten);
        // This is the change, stated as a fact about ordering rather than a stopwatch. When the
        // writer enumerated the sequence itself, record N was built after N rows had been
        // inserted and this read [0,1,2,3,4,5,6,7] -- N-1 records' worth of serialization paid
        // with the write lock held.
        Assert.Equal([0, 0, 0, 0, 0, 0, 0, 0], writtenWhenAsked);
        Assert.Equal(8, clock.Reads);
    }

    [Fact]
    public async Task APayloadZeroedOnceTheSequenceMovesOnIsStillStoredIntact()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();

        // Exactly what the Query Store repository's iterators do: serialize into a buffer, yield
        // a record pointing at it, then zero the buffer in a finally once the consumer moves on.
        // A payload is therefore only valid until the enumerator advances, so buffering the
        // ProtectedRecordWrite itself would store zeros. Buffering the framed envelope -- an
        // independent copy taken before the advance -- is what makes reading ahead sound.
        static IEnumerable<ProtectedRecordWrite> Sequence()
        {
            for (var index = 0; index < 40; index++)
            {
                var payload = Encoding.UTF8.GetBytes(new string((char)('a' + (index % 26)), 4_096));
                try
                {
                    yield return new ProtectedRecordWrite(
                        new ProtectedRecordId($"set:{index:D2}"), "kind", Captured,
                        StorageResolution.Detail, payload);
                }
                finally
                {
                    System.Security.Cryptography.CryptographicOperations.ZeroMemory(payload);
                }
            }
        }

        await store.ReplaceSetAsync("set:", Sequence());

        for (var index = 0; index < 40; index++)
        {
            using var record = await store.GetAsync($"set:{index:D2}");
            Assert.NotNull(record);
            var expected = Encoding.UTF8.GetBytes(new string((char)('a' + (index % 26)), 4_096));
            Assert.Equal(expected, record!.Payload.ToArray());
        }
    }

    [Fact]
    public async Task ARejectedRecordAbandonsTheWholeReplacementAndKeepsWhatWasThere()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        await store.ReplaceSetAsync("set:", [Write("set:a", 100), Write("set:b", 100)]);

        // Rejected while the writer is somewhere else entirely, which is the hazard: batches
        // simply stop arriving, and that is indistinguishable from a set that ended. Without an
        // explicit check before the commit, the prefix delete and whatever arrived first would
        // both be persisted -- a publish that silently dropped most of a snapshot.
        static IEnumerable<ProtectedRecordWrite> Sequence()
        {
            yield return Write("set:c", 100);
            yield return Write("elsewhere:d", 100);
        }

        var error = await Assert.ThrowsAsync<ArgumentException>(
            () => store.ReplaceSetAsync("set:", Sequence()));

        // The caller has to see its own failure, named after the argument it can fix, rather than
        // whatever wrapper the hand-off would otherwise raise.
        Assert.Equal("records", error.ParamName);
        Assert.NotNull(await store.GetAsync("set:a"));
        Assert.NotNull(await store.GetAsync("set:b"));
        Assert.Null(await store.GetAsync("set:c"));
        Assert.Equal(2, (await store.MeasureUsageAsync()).RecordCount);
    }

    [Fact]
    public async Task AFailureRaisedBySequenceItselfSurvivesTheHandOffUnchanged()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();

        static IEnumerable<ProtectedRecordWrite> Sequence()
        {
            yield return Write("set:a", 100);
            throw new InvalidDataException("the snapshot could not be built");
        }

        var error = await Assert.ThrowsAsync<InvalidDataException>(
            () => store.ReplaceSetAsync("set:", Sequence()));

        Assert.Equal("the snapshot could not be built", error.Message);
        Assert.Equal(0, (await store.MeasureUsageAsync()).RecordCount);
    }

    [Fact]
    public async Task CancellingStopsTheReplacementAndLeavesNothingRunningBehindIt()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        using var cancellation = new CancellationTokenSource();
        var produced = 0;

        IEnumerable<ProtectedRecordWrite> Sequence()
        {
            for (var index = 0; index < 10_000; index++)
            {
                if (index == 16) cancellation.Cancel();
                Interlocked.Increment(ref produced);
                yield return Write($"set:{index:D5}", 8_192);
            }
        }

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => store.ReplaceSetAsync("set:", Sequence(), cancellation.Token));

        // Preparation must not outlive the call that asked for it: once ReplaceSetAsync has
        // returned, the sequence is finished with. A producer left parked on the bounded hand-off
        // would keep enumerating the caller's snapshot after it gave up.
        var settled = produced;
        await Task.Delay(100);
        Assert.Equal(settled, produced);
        Assert.True(produced < 10_000, $"the sequence produced {produced} records despite cancelling");
        Assert.Equal(0, (await store.MeasureUsageAsync()).RecordCount);
    }

    [Fact]
    public async Task ASetLargerThanOneBatchIsStillWrittenOnceInOrderAndInFull()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var enumerated = 0;

        // Over the pipeline's 2 MiB byte budget and its 512-record cap, so this spans several
        // hand-offs rather than fitting in one. Bytes accumulate to roughly 5 MiB; peak buffering
        // stays at the budget because the writer drains batches as they arrive.
        IEnumerable<ProtectedRecordWrite> Sequence()
        {
            for (var index = 0; index < 700; index++)
            {
                Interlocked.Increment(ref enumerated);
                yield return Write($"set:{index:D4}", 8_192);
            }
        }

        var replacement = await store.ReplaceSetAsync("set:", Sequence());
        var usage = await store.MeasureUsageAsync();

        Assert.Equal(700, enumerated);
        Assert.Equal(700, replacement.RecordsWritten);
        Assert.Equal(700 * 8_192, replacement.PayloadBytes);
        Assert.Equal(700, usage.RecordCount);
        Assert.Equal(replacement.StoredBytes, usage.StoredBytes);
        using var last = await store.GetAsync("set:0699");
        Assert.NotNull(last);
    }

    /// <summary>Counts reads, so a test can tell how far the writer had got.</summary>
    private sealed class CountingTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private int _reads;

        public int Reads => Volatile.Read(ref _reads);

        public void ResetReads() => Volatile.Write(ref _reads, 0);

        public override DateTimeOffset GetUtcNow()
        {
            Interlocked.Increment(ref _reads);
            return utcNow;
        }
    }
}
