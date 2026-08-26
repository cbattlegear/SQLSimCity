using System.Diagnostics;
using System.Text;
using Microsoft.Data.Sqlite;
using SqlSimCity.Storage.Sqlite;

namespace SqlSimCity.Storage.Tests;

/// <summary>
/// Pins the prefix-delete rewrite in <see cref="SqliteProtectedRecordStore.ReplaceSetAsync"/>.
///
/// The rewrite trades an exact-but-unindexable predicate for an indexed range, so the tests
/// that matter are the ones that would catch it selecting a different set of rows. They run
/// the real store against adversarial ids and compare against the original
/// <c>substr(id, 1, n) = $prefix</c> evaluated by SQLite itself, rather than against a
/// reimplementation of prefix matching in C#.
/// </summary>
public sealed class SqlitePrefixDeleteTests : IDisposable
{
    private readonly string _directory =
        Path.Combine(Path.GetTempPath(), "sqlsimcity-prefix-tests", Guid.NewGuid().ToString("N"));

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

    private string DbPath => Path.Combine(_directory, DbFileName);

    private string RawConnectionString =>
        new SqliteConnectionStringBuilder { DataSource = DbPath, Pooling = false }.ToString();

    private SqliteProtectedRecordStore NewStore() =>
        new(_directory, DbFileName, new RetentionOptions(), TimeProvider.System);

    /// <summary>
    /// Ids chosen to break a careless rewrite: a naive <c>prefix + '\uFFFF'</c> bound drops
    /// astral-plane continuations, a LIKE rewrite treats <c>%</c> and <c>_</c> as wildcards,
    /// and byte-order reasoning that assumes ASCII gets the wrong successor for anything
    /// multi-byte. Every id here is exercised against every prefix below.
    /// </summary>
    private static readonly string[] AdversarialIds =
    [
        "qs:",
        "qs:a",
        "qs:z",
        "qs;",                      // ':' + 1 -- the exact exclusive bound for a "qs:" prefix
        "qs:\u0000embedded-nul",
        "qs:%wildcard",
        "qs:_wildcard",
        "qs:100%",
        "qs:under_score",
        "qs:'quoted'",
        "qs:\"double\"",
        "qs:back\\slash",
        "qs:\uFFFF",                // the naive sentinel itself
        "qs:\uFFFF\uFFFF",
        "qs:\U0001F600",            // surrogate pair: sorts after U+FFFF in UTF-8 bytes
        "qs:\U0010FFFF",            // highest code point
        "qs:\u00E9accented",
        "qs:\u4E2D\u6587",
        "qs:\u0301combining",
        "qs\u0000:",
        "\uFFFFqs:",
        "\U0001F600qs:",
        "qs:normalized-plan:aaaa:manifest",
        "qs:normalized-plan:aaaa:chunk:0",
        "qs:normalized-plan:aaaa\uFFFF:manifest",
        "qs:normalized-plan:aaaab:manifest",
        "qs:normalized-plan:aaa:manifest",
        "qs:query-store-slot:0:abc",
        "qs:query-store-slot:0:\U0001F600",
        "qs:query-store-slot:00:abc",
        "qs:query-store-slot:1:abc",
        "qs:query-store-slot;0:abc",
        "\u00E9",
        "\U0001F600",
        "~",
        "~~",
        "\u007F",                   // DEL: one UTF-8 byte, but outside the accepted range
    ];

    private static readonly string[] AdversarialPrefixes =
    [
        "qs:",
        "qs:a",
        "qs:normalized-plan:aaaa:",
        "qs:query-store-slot:0:",
        "qs:%",
        "qs:_",
        "qs:'",
        "qs:\uFFFF",
        "qs:\U0001F600",
        "qs:\u00E9",
        "\uFFFF",
        "\U0001F600",
        "\u00E9",
        "~",
        "\u007F",
        "qs:normalized-plan:aaaa:manifest-and-then-some-much-longer-suffix",
        "z",
    ];

    /// <summary>
    /// The property from issue #76: for every adversarial prefix, the rewritten delete must
    /// remove exactly the rows the original <c>substr()</c> predicate would have removed --
    /// no more, and no fewer.
    /// </summary>
    [Fact]
    public async Task PrefixReplacementDeletesExactlyTheSubstrMatchedRows()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        // Filler rows that sort around the adversarial ids, so the range has to land in the
        // right place in a populated index rather than on an all-but-empty table.
        await SeedUnrelatedRowsAsync(0, 500);

        foreach (var prefix in AdversarialPrefixes)
        {
            await SeedAsync(store, AdversarialIds);
            var expectedSurvivors = await SubstrNonMatchingIdsAsync(prefix);

            // The replacement set is empty, so every surviving row is one the delete spared.
            await store.ReplaceSetAsync(prefix, []);

            var actualSurvivors = await AllIdsAsync();
            Assert.Equal(expectedSurvivors, actualSurvivors);
        }
    }

    /// <summary>
    /// The same property, approached from the other side: a record written under the prefix
    /// is replaced, and one that merely sorts nearby is not. A wrong upper bound shows up
    /// here as a neighbour that disappeared.
    /// </summary>
    [Fact]
    public async Task PrefixReplacementKeepsNeighboursThatSortInsideANaiveBound()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        const string prefix = "qs:normalized-plan:aaaa:";
        var payload = Encoding.UTF8.GetBytes("payload");
        var capturedAt = new DateTimeOffset(2026, 8, 25, 12, 0, 0, TimeSpan.Zero);
        // 'aaaa\uFFFF:' and 'aaaa\U0001F600:' both sort after 'aaaa:' and are not under it.
        string[] neighbours =
        [
            "qs:normalized-plan:aaaa\uFFFF:manifest",
            "qs:normalized-plan:aaaa\U0001F600:manifest",
            "qs:normalized-plan:aaaa;manifest",
            "qs:normalized-plan:aaa:manifest",
            "qs:normalized-plan:aaaab:manifest",
        ];
        foreach (var id in neighbours)
            await store.PutAsync(id, "kind", capturedAt, StorageResolution.Detail, payload);
        await store.PutAsync($"{prefix}stale", "kind", capturedAt, StorageResolution.Detail, payload);

        await store.ReplaceSetAsync(
            prefix,
            [new ProtectedRecordWrite($"{prefix}manifest", "kind", capturedAt, StorageResolution.Detail, payload)]);

        Assert.Null(await store.GetAsync($"{prefix}stale"));
        Assert.NotNull(await store.GetAsync($"{prefix}manifest"));
        foreach (var id in neighbours)
            Assert.NotNull(await store.GetAsync(id));
    }

    /// <summary>
    /// The rewrite only pays off if it seeks the primary key, so this asserts the plan of the
    /// statement the store actually builds -- <see cref="SqlitePrefixRange.ConfigureDelete"/>
    /// is the single place that predicate is chosen -- for the two id shapes this codebase
    /// generates: a published slot and a normalized plan.
    /// </summary>
    [Theory]
    [InlineData("qs:query-store-slot:0:")]
    [InlineData("qs:query-store-slot:1:")]
    [InlineData("qs:normalized-plan:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef:")]
    public async Task TheDeleteTheStoreBuildsSeeksThePrimaryKey(string prefix)
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        await using var connection = new SqliteConnection(RawConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();

        var indexed = SqlitePrefixRange.ConfigureDelete(command, prefix, databaseEncodingIsUtf8: true);

        Assert.True(indexed);
        Assert.DoesNotContain("substr", command.CommandText, StringComparison.OrdinalIgnoreCase);
        var plan = await QueryPlanAsync(connection, command);
        Assert.Contains("SEARCH", plan, StringComparison.Ordinal);
        Assert.Contains("USING INDEX", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("SCAN", plan, StringComparison.Ordinal);
    }

    /// <summary>
    /// The counterpart: a prefix with no safe bound keeps the exact predicate, and that
    /// predicate scans. This is the cost the fallback accepts in exchange for being exactly
    /// right, and pinning it here keeps the trade-off visible.
    /// </summary>
    [Fact]
    public async Task TheFallbackDeleteIsExactAndScans()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        await using var connection = new SqliteConnection(RawConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();

        var indexed = SqlitePrefixRange.ConfigureDelete(command, "qs:\U0001F600:", databaseEncodingIsUtf8: true);

        Assert.False(indexed);
        Assert.Contains("substr", command.CommandText, StringComparison.Ordinal);
        Assert.Contains("SCAN", await QueryPlanAsync(connection, command), StringComparison.Ordinal);
    }

    /// <summary>
    /// A behavioural guard that the store really seeks the index, independent of the seam:
    /// against the same populated table, a prefix that takes the indexed range must be
    /// markedly cheaper than one that falls back to the exact predicate. Comparing the two
    /// paths on one table cancels the fixed cost they share -- a connection open and a
    /// durable commit -- so the assertion does not depend on machine speed or disk latency.
    ///
    /// Measured here: 11.2 ms indexed against 72.9 ms scanning at 250k rows. If the store
    /// stops using the range, the indexed prefix scans too and the two converge on ~1x.
    /// </summary>
    [Fact]
    public async Task TheStoreSeeksForPrefixesThatHaveABoundAndScansOnlyWhenItMust()
    {
        var store = NewStore();
        await store.EnsureReadyAsync();
        await SeedUnrelatedRowsAsync(0, 250_000);

        var indexed = await MedianReplaceMillisecondsAsync(store, "qs:normalized-plan:target:");
        var scanned = await MedianReplaceMillisecondsAsync(store, "qs:\u00E9normalized-plan:target:");

        Assert.True(
            scanned > indexed * 2.5,
            $"A prefix with an indexed bound cost {indexed:F1} ms and one that must scan cost " +
            $"{scanned:F1} ms against the same 250k-row table. They should not be comparable: " +
            "the store is scanning when it could seek the primary key.");
    }

    [Theory]
    [InlineData("qs:", "qs;")]
    [InlineData("qs:query-store-slot:0:", "qs:query-store-slot:0;")]
    [InlineData("a", "b")]
    [InlineData("~", "\u007F")]
    [InlineData("az", "a{")]
    public void AsciiPrefixesGetTheByteSuccessorAsTheirBound(string prefix, string expected)
    {
        Assert.True(SqlitePrefixRange.TryGetExclusiveUpperBound(prefix, true, out var bound));
        Assert.Equal(expected, bound);
    }

    [Theory]
    [InlineData("qs:\uFFFF")]
    [InlineData("qs:\U0001F600")]
    [InlineData("qs:\u00E9")]
    [InlineData("qs:\u0000")]
    [InlineData("qs:\u007F")]
    [InlineData("qs:\n")]
    [InlineData("")]
    public void NonAsciiPrefixesGetNoBoundAndFallBackToTheExactPredicate(string prefix)
    {
        Assert.False(SqlitePrefixRange.TryGetExclusiveUpperBound(prefix, true, out var bound));
        Assert.Equal(string.Empty, bound);
    }

    /// <summary>
    /// A UTF-16 database orders the high byte of an ASCII character too, so a byte-successor
    /// bound would select ids that do not start with the prefix. The encoding is fixed when a
    /// file is first written, so this store can meet one it did not create.
    /// </summary>
    [Fact]
    public void ANonUtf8DatabaseGetsNoBound() =>
        Assert.False(SqlitePrefixRange.TryGetExclusiveUpperBound("qs:", false, out _));

    private static async Task SeedAsync(SqliteProtectedRecordStore store, IEnumerable<string> ids)
    {
        var payload = Encoding.UTF8.GetBytes("payload");
        var capturedAt = new DateTimeOffset(2026, 8, 25, 12, 0, 0, TimeSpan.Zero);
        foreach (var id in ids)
            await store.PutAsync(id, "kind", capturedAt, StorageResolution.Detail, payload);
    }

    /// <summary>
    /// Asks SQLite which rows the original predicate would have spared, so the expectation
    /// comes from the engine's own collation rather than from a C# restatement of it.
    /// </summary>
    private async Task<List<string>> SubstrNonMatchingIdsAsync(string prefix)
    {
        await using var connection = new SqliteConnection(RawConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id FROM protected_records
            WHERE substr(id, 1, $length) IS NOT $prefix
            ORDER BY id;
            """;
        command.Parameters.AddWithValue("$length", prefix.Length);
        command.Parameters.AddWithValue("$prefix", prefix);
        return await ReadIdsAsync(command);
    }

    private async Task<List<string>> AllIdsAsync()
    {
        await using var connection = new SqliteConnection(RawConnectionString);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT id FROM protected_records ORDER BY id;";
        return await ReadIdsAsync(command);
    }

    private static async Task<List<string>> ReadIdsAsync(SqliteCommand command)
    {
        var ids = new List<string>();
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) ids.Add(reader.GetString(0));
        return ids;
    }

    private static async Task<string> QueryPlanAsync(SqliteConnection connection, SqliteCommand command)
    {
        await using var plan = connection.CreateCommand();
        plan.CommandText = $"EXPLAIN QUERY PLAN {command.CommandText}";
        foreach (SqliteParameter parameter in command.Parameters)
            plan.Parameters.AddWithValue(parameter.ParameterName, parameter.Value);
        var lines = new List<string>();
        await using var reader = await plan.ExecuteReaderAsync();
        while (await reader.ReadAsync()) lines.Add(reader.GetString(3));
        return string.Join(" | ", lines);
    }

    /// <summary>
    /// Seeds filler rows directly, because the point of this fixture is behaviour against a
    /// populated table -- not the cost of a hundred thousand stores.
    /// </summary>
    private async Task SeedUnrelatedRowsAsync(int start, int end)
    {
        await using var connection = new SqliteConnection(RawConnectionString);
        await connection.OpenAsync();
        await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync();
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO protected_records
                (id, record_kind, captured_at_unix_ms, resolution, envelope, stored_at_unix_ms)
            VALUES ($id, 'filler', 0, 'Detail', $envelope, 0);
            """;
        var id = command.Parameters.Add("$id", SqliteType.Text);
        var envelope = command.Parameters.Add("$envelope", SqliteType.Blob);
        envelope.Value = new byte[64];
        for (var index = start; index < end; index++)
        {
            id.Value = $"qs:query-store-slot:0:{index:x32}";
            await command.ExecuteNonQueryAsync();
        }
        await transaction.CommitAsync();
    }

    private static async Task<double> MedianReplaceMillisecondsAsync(
        SqliteProtectedRecordStore store, string prefix)
    {
        var write = new ProtectedRecordWrite(
            $"{prefix}manifest", "kind", DateTimeOffset.UnixEpoch, StorageResolution.Detail, new byte[8]);
        // Warm up so the first sample does not carry one-off cost unrelated to the predicate.
        for (var attempt = 0; attempt < 3; attempt++)
            await store.ReplaceSetAsync(prefix, [write]);
        var samples = new List<double>();
        for (var attempt = 0; attempt < 11; attempt++)
        {
            var watch = Stopwatch.StartNew();
            await store.ReplaceSetAsync(prefix, [write]);
            watch.Stop();
            samples.Add(watch.Elapsed.TotalMilliseconds);
        }
        samples.Sort();
        return samples[samples.Count / 2];
    }
}
