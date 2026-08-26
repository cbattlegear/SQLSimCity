using System.Text;
using SqlSimCity.Storage.Sqlite;

namespace SqlSimCity.Storage.Tests;

/// <summary>
/// Issue #82 carried two headline figures -- "~2 GB of write churn per publish" and "~25 GB of
/// plans" -- that were arithmetic over assumed inputs rather than anything the code bounds. These
/// pin the instrumentation that replaces that arithmetic with measurement, so the numbers an
/// operator reads are the ones the store really moved.
///
/// Every assertion here cross-checks one reported figure against a second, independently derived
/// one. A telemetry test that only asserts "some number came back" would pass against a constant.
/// </summary>
public sealed class SqliteProtectedRecordStoreTelemetryTests : IDisposable
{
    private readonly string _directory =
        Path.Combine(Path.GetTempPath(), "sqlsimcity-storage-telemetry", Guid.NewGuid().ToString("N"));

    private const string DbFileName = "protected-storage.db";

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

    private SqliteProtectedRecordStore NewStore(
        TimeProvider? timeProvider = null, RetentionOptions? retention = null) =>
        new(_directory, DbFileName, retention ?? new RetentionOptions(), timeProvider ?? TimeProvider.System);

    private static ProtectedRecordWrite Write(
        string id, string kind, int payloadBytes, DateTimeOffset capturedAt,
        StorageResolution resolution = StorageResolution.Detail) =>
        new(new ProtectedRecordId(id), kind, capturedAt, resolution,
            Encoding.UTF8.GetBytes(new string('x', payloadBytes)));

    [Fact]
    public async Task ReplacementReportsThePayloadItWasGivenAndTheLargerFramedSizeItStored()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var captured = new DateTimeOffset(2026, 8, 20, 9, 0, 0, TimeSpan.Zero);
        ProtectedRecordWrite[] writes =
        [
            Write("set:a", "kind-one", 1_000, captured),
            Write("set:b", "kind-one", 2_500, captured),
            Write("set:c", "kind-two", 400, captured),
        ];

        var replacement = await store.ReplaceSetAsync("set:", writes);
        var usage = await store.MeasureUsageAsync();

        Assert.Equal(3, replacement.RecordsWritten);
        Assert.Equal(3_900, replacement.PayloadBytes);
        // Framing is real overhead an operator pays for, so the reported stored size must be the
        // framed size and not the payload size relabelled.
        Assert.True(
            replacement.StoredBytes > replacement.PayloadBytes,
            $"stored {replacement.StoredBytes} should exceed payload {replacement.PayloadBytes}");
        // The write path and the measurement path derive the byte total independently. They have
        // to agree, or one of the two numbers an operator sees is fiction.
        Assert.Equal(replacement.StoredBytes, usage.StoredBytes);
        Assert.Equal(3, usage.RecordCount);
        Assert.Equal(
            replacement.StoredBytes,
            usage.StoredBytesForKinds(["kind-one", "kind-two"]));
        Assert.Equal(2, usage.RecordCountForKinds(["kind-one"]));
    }

    [Fact]
    public async Task ReplacementReportsExactlyWhatThePrefixDeleteRemoved()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var captured = new DateTimeOffset(2026, 8, 20, 9, 0, 0, TimeSpan.Zero);
        var first = await store.ReplaceSetAsync("set:",
        [
            Write("set:a", "kind", 1_000, captured),
            Write("set:b", "kind", 1_000, captured),
            Write("set:c", "kind", 1_000, captured),
        ]);
        // Outside the prefix, so the replacement must not see it at all.
        await store.PutAsync("other:a", "kind", captured, StorageResolution.Detail, "keep"u8.ToArray());

        var second = await store.ReplaceSetAsync("set:", [Write("set:a", "kind", 50, captured)]);

        Assert.Equal(3, second.RecordsDeleted);
        // What the second replacement says it removed is exactly what the first said it wrote.
        // A count alone would pass while the byte figure was any constant.
        Assert.Equal(first.StoredBytes, second.DeletedBytes);
        Assert.NotNull(await store.GetAsync("other:a"));
    }

    [Fact]
    public async Task ReplacementReportsAWriteLockHoldNoLongerThanTheCallThatContainsIt()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var captured = new DateTimeOffset(2026, 8, 20, 9, 0, 0, TimeSpan.Zero);
        var writes = Enumerable.Range(0, 200)
            .Select(index => Write($"set:{index:D4}", "kind", 2_048, captured))
            .ToArray();

        var wall = System.Diagnostics.Stopwatch.StartNew();
        var replacement = await store.ReplaceSetAsync("set:", writes);
        wall.Stop();

        Assert.True(replacement.WriteLockHold > TimeSpan.Zero, "the hold must be measured, not zero");
        // The hold is a section inside the call, so a hold longer than the whole call means the
        // stopwatch is measuring something other than the transaction.
        Assert.True(
            replacement.WriteLockHold <= wall.Elapsed,
            $"hold {replacement.WriteLockHold} exceeded call {wall.Elapsed}");
    }

    [Fact]
    public async Task ThePruneBacklogCountsTheSameRecordsThePruneThenDeletes()
    {
        var clock = new TestTimeProvider(new DateTimeOffset(2026, 8, 20, 9, 0, 0, TimeSpan.Zero));
        var retention = new RetentionOptions { PruneBatchSize = 10 };
        using var store = NewStore(clock, retention);
        await store.EnsureReadyAsync();

        var expiredAt = clock.GetUtcNow() - retention.DetailRetention - TimeSpan.FromHours(1);
        for (var index = 0; index < 25; index++)
            await store.PutAsync(
                $"expired:{index:D3}", "kind", expiredAt, StorageResolution.Detail, "x"u8.ToArray());
        for (var index = 0; index < 5; index++)
            await store.PutAsync(
                $"fresh:{index:D3}", "kind", clock.GetUtcNow(), StorageResolution.Detail, "x"u8.ToArray());

        var before = await store.MeasureUsageAsync();
        Assert.Equal(25, before.ExpiredRecordCount);
        Assert.Equal(30, before.RecordCount);

        // Draining it batch by batch proves the two predicates select the same rows: if the
        // backlog counted anything the prune cannot reach, this loop would never reach zero.
        var drained = 0;
        for (var pass = 0; pass < 10; pass++)
        {
            var pruned = await store.PruneExpiredAsync();
            drained += pruned;
            var after = await store.MeasureUsageAsync();
            Assert.Equal(25 - drained, after.ExpiredRecordCount);
            if (pruned == 0) break;
        }

        Assert.Equal(25, drained);
        Assert.Equal(5, (await store.MeasureUsageAsync()).RecordCount);
    }

    [Fact]
    public async Task OnDiskBytesExceedStoredBytesBecausePagesAreNotTheirContents()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var captured = new DateTimeOffset(2026, 8, 20, 9, 0, 0, TimeSpan.Zero);
        await store.ReplaceSetAsync("set:", Enumerable.Range(0, 100)
            .Select(index => Write($"set:{index:D3}", "kind", 4_096, captured)));

        var usage = await store.MeasureUsageAsync();

        Assert.True(usage.StoredBytes >= 100 * 4_096, $"stored {usage.StoredBytes} is too small");
        // The gap is the point of reporting both: page overhead and free pages a delete left
        // behind are disk the operator has lost and cannot see in the record total.
        Assert.True(
            usage.OnDiskBytes > usage.StoredBytes,
            $"on disk {usage.OnDiskBytes} should exceed stored {usage.StoredBytes}");
    }

    [Fact]
    public async Task OldestFirstListingIsRestrictedToTheNamedKindsAndTotallyOrdered()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var baseline = new DateTimeOffset(2026, 8, 20, 9, 0, 0, TimeSpan.Zero);
        await store.PutAsync("cache:new", "cached", baseline.AddHours(2), StorageResolution.Detail, "x"u8.ToArray());
        await store.PutAsync("cache:old", "cached", baseline, StorageResolution.Detail, "x"u8.ToArray());
        await store.PutAsync("cache:mid", "cached", baseline.AddHours(1), StorageResolution.Detail, "x"u8.ToArray());
        // Older than all of them, and of a kind that is not being asked for.
        await store.PutAsync(
            "snapshot:a", "not-cached", baseline.AddYears(-1), StorageResolution.HourlyRollup, "x"u8.ToArray());

        var oldest = await store.ListOldestAsync(["cached"], 10);

        Assert.Equal(
            ["cache:old", "cache:mid", "cache:new"],
            oldest.Select(id => id.Value).ToArray());
    }

    [Fact]
    public async Task RecordsCapturedInTheSameInstantAreOrderedByIdSoEvictionConverges()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var sameInstant = new DateTimeOffset(2026, 8, 20, 9, 0, 0, TimeSpan.Zero);
        foreach (var suffix in new[] { "c", "a", "d", "b" })
            await store.PutAsync(
                $"cache:{suffix}", "cached", sameInstant, StorageResolution.Detail, "x"u8.ToArray());

        var first = await store.ListOldestAsync(["cached"], 2);
        var second = await store.ListOldestAsync(["cached"], 2);

        // Every record of one hydrated plan shares a captured instant. Without the id tiebreak
        // the same page could come back in a different order each call, and an eviction loop that
        // deletes the head of the list would keep seeing a different head and never finish.
        Assert.Equal(["cache:a", "cache:b"], first.Select(id => id.Value).ToArray());
        Assert.Equal(first.Select(id => id.Value), second.Select(id => id.Value));
    }
}
