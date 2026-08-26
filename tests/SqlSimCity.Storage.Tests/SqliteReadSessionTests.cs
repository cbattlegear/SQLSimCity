using System.Diagnostics;
using System.Text;

namespace SqlSimCity.Storage.Tests;

using SqlSimCity.Storage.Sqlite;

/// <summary>
/// Pins the bounded read session from issue #77.
///
/// <see cref="SqliteProtectedRecordStore"/> disables connection pooling on purpose -- pooling
/// keeps a native handle, and on Windows a file lock, alive after the wrapper is disposed --
/// so every <see cref="IProtectedRecordStore.GetAsync"/> pays a full connection open. That is
/// the right trade for a single read and the wrong one for a loop over a page of records, so
/// the store also offers a session that serves a batch from one connection and closes
/// deterministically.
/// </summary>
public sealed class SqliteReadSessionTests : IDisposable
{
    private readonly string _directory =
        Path.Combine(Path.GetTempPath(), "sqlsimcity-session-tests", Guid.NewGuid().ToString("N"));

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

    private SqliteProtectedRecordStore NewStore() =>
        new(_directory, DbFileName, new RetentionOptions(), TimeProvider.System);

    [Fact]
    public async Task SessionReadsAgreeWithSingleReads()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        var capturedAt = new DateTimeOffset(2026, 8, 25, 9, 30, 0, TimeSpan.Zero);
        for (var index = 0; index < 25; index++)
            await store.PutAsync(
                $"qs:record-{index}", $"kind-{index}", capturedAt.AddMinutes(index),
                index % 2 == 0 ? StorageResolution.Detail : StorageResolution.HourlyRollup,
                Encoding.UTF8.GetBytes($"payload-{index}"));

        await using var session = await store.BeginReadSessionAsync();
        for (var index = 0; index < 25; index++)
        {
            using var direct = await store.GetAsync($"qs:record-{index}");
            using var batched = await session.GetAsync($"qs:record-{index}");
            Assert.NotNull(batched);
            Assert.Equal(direct!.Id, batched!.Id);
            Assert.Equal(direct.RecordKind, batched.RecordKind);
            Assert.Equal(direct.CapturedAt, batched.CapturedAt);
            Assert.Equal(direct.Resolution, batched.Resolution);
            Assert.Equal(direct.Payload.ToArray(), batched.Payload.ToArray());
        }

        Assert.Null(await session.GetAsync("qs:absent"));
    }

    /// <summary>
    /// A session must not pin a stale view of the store. It holds a connection, not an open
    /// transaction, so a write committed elsewhere is visible to a later read on the same
    /// session -- which is what lets the collection loop hydrate text on demand mid-batch.
    /// </summary>
    [Fact]
    public async Task SessionSeesWritesCommittedAfterItOpened()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        var capturedAt = new DateTimeOffset(2026, 8, 25, 9, 30, 0, TimeSpan.Zero);
        await store.PutAsync(
            "qs:before", "kind", capturedAt, StorageResolution.Detail, Encoding.UTF8.GetBytes("before"));

        await using var session = await store.BeginReadSessionAsync();
        using (var before = await session.GetAsync("qs:before")) Assert.NotNull(before);
        Assert.Null(await session.GetAsync("qs:after"));

        await store.PutAsync(
            "qs:after", "kind", capturedAt, StorageResolution.Detail, Encoding.UTF8.GetBytes("after"));

        using var after = await session.GetAsync("qs:after");
        Assert.NotNull(after);
        Assert.Equal("after", Encoding.UTF8.GetString(after!.Payload.Span));

        await store.DeleteAsync("qs:before");
        Assert.Null(await session.GetAsync("qs:before"));
    }

    /// <summary>
    /// The reason pooling was rejected: a handle that outlives its wrapper holds the file.
    /// Disposing a session must free the database immediately, so an operator (or a test)
    /// can move or delete the directory straight afterwards.
    /// </summary>
    [Fact]
    public async Task DisposingASessionReleasesTheDatabaseFile()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        await store.PutAsync(
            "qs:held", "kind", DateTimeOffset.UnixEpoch, StorageResolution.Detail,
            new byte[] { 1, 2, 3 });

        var session = await store.BeginReadSessionAsync();
        using (var record = await session.GetAsync("qs:held")) Assert.NotNull(record);
        await session.DisposeAsync();
        store.Dispose();

        var copy = Path.Combine(_directory, "moved.db");
        File.Move(Path.Combine(_directory, DbFileName), copy);
        Assert.True(File.Exists(copy));
    }

    /// <summary>
    /// The guard for the N+1 itself. A session serves a batch from one connection, so reading
    /// a page of records through it must cost far less than reading the same records one
    /// connection at a time. Comparing the two against the same store cancels machine speed.
    ///
    /// Measured here: 1.63 ms per record opening a connection each time against 0.007 ms on a
    /// shared connection -- and a page of 50 summaries is about 55 reads.
    /// </summary>
    [Fact]
    public async Task ABatchOfReadsIsFarCheaperThroughASessionThanOneConnectionEach()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        const int recordCount = 200;
        for (var index = 0; index < recordCount; index++)
            await store.PutAsync(
                $"qs:batch-{index:D4}", "kind", DateTimeOffset.UnixEpoch,
                StorageResolution.Detail, Encoding.UTF8.GetBytes($"payload-{index}"));

        var perConnection = await MedianMillisecondsAsync(async () =>
        {
            for (var index = 0; index < recordCount; index++)
                (await store.GetAsync($"qs:batch-{index:D4}"))?.Dispose();
        });
        var perSession = await MedianMillisecondsAsync(async () =>
        {
            await using var session = await store.BeginReadSessionAsync();
            for (var index = 0; index < recordCount; index++)
                (await session.GetAsync($"qs:batch-{index:D4}"))?.Dispose();
        });

        Assert.True(
            perSession * 5 < perConnection,
            $"Reading {recordCount} records took {perConnection:F1} ms one connection at a time " +
            $"and {perSession:F1} ms through a session. The session is not amortising the " +
            "connection open, so the read path is still paying it per row.");
    }

    private static async Task<double> MedianMillisecondsAsync(Func<Task> body)
    {
        await body();
        var samples = new List<double>();
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var watch = Stopwatch.StartNew();
            await body();
            watch.Stop();
            samples.Add(watch.Elapsed.TotalMilliseconds);
        }
        samples.Sort();
        return samples[samples.Count / 2];
    }
}
