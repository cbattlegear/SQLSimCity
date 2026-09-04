using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using SqlSimCity.Archive;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Archive.Tests;

public sealed class ArchivePackageTests : IDisposable
{
    private readonly string _directory = Path.Combine(AppContext.BaseDirectory, "archive-test-work", Guid.NewGuid().ToString("N"));

    public ArchivePackageTests() => Directory.CreateDirectory(_directory);

    [Fact]
    public void Writer_is_deterministic_and_preserves_exact_decimal_strings()
    {
        var first = Path.Combine(_directory, "first.ssca");
        var second = Path.Combine(_directory, "second.ssca");
        var payload = ArchiveJson.SerializeCanonical(new
        {
            bigint = "184467440737095516151234567890",
            exactDecimal = "1000000000000000000.0000000000000000001",
        });
        var archive = Build([new ArchivePayload(
            "evidence/exact.json", "evidence", payload, 1,
            new ArchiveSourceStamp(At, At.AddMinutes(1), "epoch-0042", "HourlyRollup"))]);

        ArchivePackageWriter.Write(first, archive.Manifest, archive.Payloads, overwrite: false);
        ArchivePackageWriter.Write(second, archive.Manifest, archive.Payloads, overwrite: false);

        Assert.Equal(File.ReadAllBytes(first), File.ReadAllBytes(second));
        using var package = ArchivePackageReader.Open(first, 4 * 1024 * 1024);
        Assert.Equal(payload, package.ReadEntry("evidence/exact.json"));
        Assert.Equal("epoch-0042", package.Manifest.Entries[0].Source.ResetEpoch);
    }

    [Fact]
    public void Reader_rejects_corrupt_digest_without_publishing()
    {
        var path = WriteSimple();
        var bytes = File.ReadAllBytes(path);
        bytes[^1] ^= 0x7f;
        File.WriteAllBytes(path, bytes);

        var error = Assert.Throws<ArchiveValidationException>(
            () => ArchivePackageReader.Open(path, 4 * 1024 * 1024));
        Assert.Contains("SHA-256", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Reader_rejects_truncation_and_trailing_bytes()
    {
        var truncated = WriteSimple("truncated.ssca");
        var bytes = File.ReadAllBytes(truncated);
        File.WriteAllBytes(truncated, bytes[..^1]);
        Assert.Throws<ArchiveValidationException>(() => ArchivePackageReader.Open(truncated, 4 * 1024 * 1024));

        var trailing = WriteSimple("trailing.ssca");
        using (var stream = File.Open(trailing, FileMode.Append, FileAccess.Write))
            stream.WriteByte(0);
        Assert.Throws<ArchiveValidationException>(() => ArchivePackageReader.Open(trailing, 4 * 1024 * 1024));
    }

    [Theory]
    [InlineData("../escape.json")]
    [InlineData("C:\\escape.json")]
    [InlineData("/absolute.json")]
    public void Reader_rejects_traversal_and_special_entry_names(string name)
    {
        var payload = ArchiveJson.SerializeCanonical(new { safe = true });
        var archive = Build([new ArchivePayload(
            "evidence/item.json", "evidence", payload, 1,
            new ArchiveSourceStamp(At, At, null, "PointInTime"))]);
        var manifest = archive.Manifest with
        {
            Entries = [archive.Manifest.Entries[0] with { Name = name }],
        };
        var path = Path.Combine(_directory, "bad-name.ssca");
        WriteRaw(path, manifest, [payload]);

        Assert.Throws<ArchiveValidationException>(() => ArchivePackageReader.Open(path, 4 * 1024 * 1024));
    }

    [Fact]
    public void Reader_rejects_duplicate_names_and_unsupported_major_version()
    {
        var payload = ArchiveJson.SerializeCanonical(new { safe = true });
        var built = Build([new ArchivePayload(
            "evidence/item.json", "evidence", payload, 1, new ArchiveSourceStamp(At, At, null, "PointInTime"))]);
        var duplicate = built.Manifest with { Entries = [built.Manifest.Entries[0], built.Manifest.Entries[0]] };
        var duplicatePath = Path.Combine(_directory, "duplicate.ssca");
        WriteRaw(duplicatePath, duplicate, [payload, payload]);
        Assert.Throws<ArchiveValidationException>(() => ArchivePackageReader.Open(duplicatePath, 4 * 1024 * 1024));

        var unsupported = built.Manifest with { SchemaVersion = "2.0" };
        var unsupportedPath = Path.Combine(_directory, "unsupported.ssca");
        WriteRaw(unsupportedPath, unsupported, [payload]);
        Assert.Throws<ArchiveValidationException>(() => ArchivePackageReader.Open(unsupportedPath, 4 * 1024 * 1024));
    }

    [Fact]
    public void Reader_rejects_oversized_archive_and_deep_json()
    {
        var path = WriteSimple();
        Assert.Throws<ArchiveValidationException>(() => ArchivePackageReader.Open(path, 8));

        var deep = Encoding.UTF8.GetBytes(new string('[', 65) + "0" + new string(']', 65));
        Assert.ThrowsAny<Exception>(() => ArchiveJson.Canonicalize(deep));
    }

    [Fact]
    public void Json_rejects_duplicate_properties_at_any_depth()
    {
        Assert.Throws<ArchiveValidationException>(() =>
            ArchiveJson.Canonicalize("""{"outer":{"value":1,"value":2}}"""u8));
    }

    [Fact]
    public void Json_rejects_numeric_enum_values()
    {
        Assert.ThrowsAny<Exception>(() =>
            ArchiveJson.Deserialize<EnumHolder>("""{"status":999}"""u8));
    }

    [Fact]
    public void Reader_rejects_noncanonical_entry_bytes_even_with_matching_digest()
    {
        var bytes = """{ "value" : "42" }"""u8.ToArray();
        var built = Build([Payload()]);
        var entry = built.Manifest.Entries[0] with
        {
            ByteLength = bytes.LongLength,
            Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
        };
        var manifest = built.Manifest with { Entries = [entry] };
        var path = Path.Combine(_directory, "noncanonical-entry.ssca");
        WriteRaw(path, manifest, [bytes]);

        var error = Assert.Throws<ArchiveValidationException>(
            () => ArchivePackageReader.Open(path, 4 * 1024 * 1024));
        Assert.Contains("canonical", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Default_redactor_removes_raw_sensitive_text_and_escapes_xss()
    {
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.Fixture, DataStatus.Available, At, At, "safe", "safe");
        var text = new QueryTextDescriptorV1(
            QueryTextAvailability.Available,
            "SELECT '<script>alert(1)</script>' FROM SecretTable",
            null,
            "raw");
        var family = new QueryFamilySummaryV1(
            "family", "database", "hash", null, text,
            [new PhysicalQueryIdentityV1("database", "1", "2", "hash",
                new QueryContextSettingsV1("1", "en", null, null, null, null), text)],
            "1", "2", "3", "4", "5", At, At, evidence);

        var redacted = new ArchiveRedactor(includeProtectedIdentifiers: false).Redact(family);
        var json = Encoding.UTF8.GetString(ArchiveJson.SerializeCanonical(redacted));

        Assert.Null(redacted.Text.NormalizedText);
        Assert.NotNull(redacted.Text.NormalizedTextFingerprint);
        Assert.DoesNotContain("SecretTable", json, StringComparison.Ordinal);
        Assert.DoesNotContain("<script>", json, StringComparison.Ordinal);
    }

    [Fact]
    public void Redactor_preserves_epoch_boundaries_without_leaking_database_identity()
    {
        var status = new QueryStoreCollectorStatusV1(
            "1.0", QueryStoreCollectorState.Ready, 1, At, At, null,
            [new QueryStoreDatabaseStatusV1(
                "sales", QueryStoreCollectionStateV1.ReadWrite, "query-store:sales",
                At, At, "sales collection is current")],
            "ready");

        var redacted = new ArchiveRedactor(includeProtectedIdentifiers: false).Redact(status);
        var protectedValue = new ArchiveRedactor(includeProtectedIdentifiers: true).Redact(status);

        Assert.StartsWith("database-", redacted.Databases[0].DatabaseId, StringComparison.Ordinal);
        Assert.StartsWith("reset-epoch-", redacted.Databases[0].ResetEpoch, StringComparison.Ordinal);
        Assert.DoesNotContain("sales", redacted.Databases[0].Reason, StringComparison.Ordinal);
        Assert.Equal("query-store:sales", protectedValue.Databases[0].ResetEpoch);
    }

    [Fact]
    public void Writer_is_atomic_and_refuses_overwrite_by_default()
    {
        var path = WriteSimple();
        var original = File.ReadAllBytes(path);
        var built = Build([Payload()]);

        Assert.Throws<IOException>(() =>
            ArchivePackageWriter.Write(path, built.Manifest, built.Payloads, overwrite: false));
        Assert.Equal(original, File.ReadAllBytes(path));
    }

    [Fact]
    public void Path_resolver_rejects_traversal_and_directory()
    {
        Assert.Throws<ArchiveValidationException>(() => ArchivePathResolver.Resolve(
            new ArchiveSourceOptions(_directory, "..\\escape.ssca")));
        Assert.Throws<ArchiveValidationException>(() => ArchivePackageReader.Open(
            _directory, 4 * 1024 * 1024));
    }

    [Fact]
    public async Task Archive_source_reads_100k_families_in_bounded_chunks()
    {
        const int total = 100_000;
        const int chunkSize = 200;
        var payloads = new List<ArchivePayload> { AtlasPayload() };
        var entries = new List<string>();
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.Fixture, DataStatus.Available, At, At.AddHours(1), "fixture", "aggregate");
        for (var offset = 0; offset < total; offset += chunkSize)
        {
            var chunk = Enumerable.Range(offset, chunkSize).Select(index =>
                new QueryFamilySummaryV1(
                    $"family-{index:D6}", "database", $"hash-{index:D6}", null,
                    new QueryTextDescriptorV1(QueryTextAvailability.Restricted, null, null, "omitted"),
                    [],
                    index.ToString(CultureInfo.InvariantCulture),
                    index.ToString(CultureInfo.InvariantCulture),
                    index.ToString(CultureInfo.InvariantCulture),
                    index.ToString(CultureInfo.InvariantCulture),
                    index.ToString(CultureInfo.InvariantCulture),
                    At, At, evidence)).ToArray();
            var name = $"query-store/pages/chunk-{offset / chunkSize:D5}.json";
            entries.Add(name);
            payloads.Add(new ArchivePayload(
                name, "query-store", ArchiveJson.SerializeCanonical(chunk), chunk.Length,
                new ArchiveSourceStamp(At, At.AddHours(1), "epoch-1", "HourlyRollup")));
        }
        var index = new QueryStoreArchiveIndex(
            new Dictionary<string, string>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal),
            new Dictionary<string, ArchivePageSeries>(StringComparer.Ordinal)
            {
                ["cpu|*"] = new(chunkSize, total, entries),
            });
        payloads.Add(new ArchivePayload(
            ArchiveSource.QueryStoreIndexEntry, "query-store", ArchiveJson.SerializeCanonical(index), total,
            new ArchiveSourceStamp(At, At.AddHours(1), "epoch-1", "HourlyRollup")));
        var limits = new ArchiveLimits(256L * 1024 * 1024, 1000, 200_000, 128, 120_000);
        var manifest = ArchivePackageWriter.Preview(
            "1.0.0", At, new ArchiveTarget("opaque", "alias"),
            new ArchiveRedactionPolicy("default", false, false, false, ["raw SQL"]),
            ["atlas-v1", "canonical-json-v1", "query-store-v1", "uncompressed-container-v1"],
            ["paged-query-store"], limits, payloads);
        var path = Path.Combine(_directory, "scale.ssca");
        ArchivePackageWriter.Write(
            path, manifest,
            payloads.ToDictionary(value => value.Name, value => value.Bytes, StringComparer.Ordinal),
            overwrite: false);

        using var source = ArchiveSource.Open(new ArchiveSourceOptions(_directory, "scale.ssca"));
        var first = await source.GetQueriesAsync(null, "cpu", 50, null, CancellationToken.None);
        var tokenScope = Convert.ToHexStringLower(
            SHA256.HashData(Encoding.UTF8.GetBytes("query:cpu|*")).AsSpan(0, 8));
        var lastToken = Convert.ToBase64String(
            Encoding.UTF8.GetBytes($"99950:50:{tokenScope}"));
        var last = await source.GetQueriesAsync(null, "cpu", 50, lastToken, CancellationToken.None);

        Assert.Equal(50, first.Items.Count);
        Assert.StartsWith("family-", first.Items[0].FamilyId, StringComparison.Ordinal);
        Assert.DoesNotContain("000000", first.Items[0].FamilyId, StringComparison.Ordinal);
        Assert.Equal(QueryStoreSource.ImportedArchive, first.Items[0].Evidence.Source);
        Assert.Equal(DataStatus.Stale, first.Items[0].Evidence.Status);
        Assert.StartsWith("family-", last.Items[^1].FamilyId, StringComparison.Ordinal);
        Assert.Equal("100000", last.TotalCount);
        Assert.Null(last.NextPageToken);
        await Assert.ThrowsAsync<QueryStorePageTokenException>(() =>
            source.GetQueriesAsync(null, "cpu", 51, first.NextPageToken, CancellationToken.None));
    }

    [Fact]
    public async Task Archive_source_handles_partial_sections_and_cancellation()
    {
        var payloads = new[] { AtlasPayload() };
        var limits = new ArchiveLimits(1024 * 1024, 10, 100, 128, 10_000);
        var manifest = ArchivePackageWriter.Preview(
            "1.0.0", At, new ArchiveTarget("opaque", "alias"),
            new ArchiveRedactionPolicy("default", false, false, false, []),
            ["atlas-v1", "canonical-json-v1", "uncompressed-container-v1"], [], limits, payloads);
        var path = Path.Combine(_directory, "partial.ssca");
        ArchivePackageWriter.Write(
            path, manifest,
            payloads.ToDictionary(value => value.Name, value => value.Bytes, StringComparer.Ordinal),
            overwrite: false);

        using var source = ArchiveSource.Open(new ArchiveSourceOptions(_directory, "partial.ssca"));
        Assert.Empty((await source.GetSummariesAsync(CancellationToken.None)).Databases);
        Assert.Equal(QueryStoreCollectorState.Disabled,
            (await source.GetStatusAsync(CancellationToken.None)).State);
        Assert.Null(source.GetCurrentResponse().Snapshot);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            source.GetQueriesAsync(null, "cpu", 50, null, cancellation.Token));
    }

    [Fact]
    public async Task Archive_source_does_not_trust_redaction_claims_or_render_raw_sql()
    {
        var rawText = "SELECT '<script>alert(1)</script>' FROM SecretTable WHERE id = 93847";
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.Fixture, DataStatus.Available, At, At.AddMinutes(1), "source", "source");
        var family = new QueryFamilySummaryV1(
            "family", "database", "query-hash", null,
            new QueryTextDescriptorV1(QueryTextAvailability.Available, rawText, null, "untrusted"),
            [], "1", "2", "3", "4", "5", At, At, evidence);
        var pageName = "query-store/pages/page-00000.json";
        var index = new QueryStoreArchiveIndex(
            new Dictionary<string, string>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal),
            new Dictionary<string, ArchivePageSeries>(StringComparer.Ordinal)
            {
                ["cpu|*"] = new(1, 1, [pageName]),
            });
        var payloads = new[]
        {
            AtlasPayload(),
            new ArchivePayload(
                pageName, "query-store", ArchiveJson.SerializeCanonical(new[] { family }), 1,
                new ArchiveSourceStamp(At, At, null, "PointInTime")),
            new ArchivePayload(
                ArchiveSource.QueryStoreIndexEntry, "query-store", ArchiveJson.SerializeCanonical(index), 1,
                new ArchiveSourceStamp(At, At, null, "PointInTime")),
        };
        var manifest = ArchivePackageWriter.Preview(
            "1.0.0", At, new ArchiveTarget("opaque", "<img src=x onerror=alert(1)>"),
            new ArchiveRedactionPolicy("dishonest", false, false, false, []),
            ["atlas-v1", "canonical-json-v1", "query-store-v1", "uncompressed-container-v1"],
            ["paged-query-store"], new ArchiveLimits(1024 * 1024, 10, 100, 128, 10_000), payloads);
        var path = Path.Combine(_directory, "dishonest-redaction.ssca");
        ArchivePackageWriter.Write(
            path, manifest,
            payloads.ToDictionary(value => value.Name, value => value.Bytes, StringComparer.Ordinal),
            overwrite: false);

        using var source = ArchiveSource.Open(new ArchiveSourceOptions(_directory, Path.GetFileName(path)));
        var page = await source.GetQueriesAsync(null, "cpu", 1, null, CancellationToken.None);
        var serialized = Encoding.UTF8.GetString(ArchiveJson.SerializeCanonical(page));

        Assert.Null(page.Items[0].Text.NormalizedText);
        Assert.NotNull(page.Items[0].Text.NormalizedTextFingerprint);
        Assert.DoesNotContain("SecretTable", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("<script>", serialized, StringComparison.Ordinal);
        Assert.Equal(QueryStoreSource.ImportedArchive, page.Items[0].Evidence.Source);
    }

    [Fact]
    public void Archive_source_rejects_unknown_required_features_before_publication()
    {
        var payloads = new[] { AtlasPayload() };
        var manifest = ArchivePackageWriter.Preview(
            "1.0.0", At, new ArchiveTarget("opaque", "alias"),
            new ArchiveRedactionPolicy("default", false, false, false, []),
            ["atlas-v1", "canonical-json-v1", "future-executable-v1", "uncompressed-container-v1"],
            [], new ArchiveLimits(1024 * 1024, 10, 100, 128, 10_000), payloads);
        var path = Path.Combine(_directory, "unknown-feature.ssca");
        ArchivePackageWriter.Write(
            path, manifest,
            payloads.ToDictionary(value => value.Name, value => value.Bytes, StringComparer.Ordinal),
            overwrite: false);

        Assert.Throws<ArchiveValidationException>(() =>
            ArchiveSource.Open(new ArchiveSourceOptions(_directory, Path.GetFileName(path))));
    }

    [Fact]
    public async Task Archive_city_repages_objects_and_binds_tokens_to_page_size()
    {
        var fixture = new FixtureDatabaseCitySource();
        var sourceSummaries = await fixture.GetSummariesAsync(CancellationToken.None);
        DatabaseCitySummaryV1? database = null;
        DatabaseCityPageV1? sourcePage = null;
        foreach (var candidate in sourceSummaries.Databases)
        {
            var candidatePage = await fixture.GetDatabaseAsync(
                candidate.DatabaseId, DatabaseCityMetric.Cpu, 24, null, CancellationToken.None);
            if (candidatePage is { Objects.Count: > 2 })
            {
                database = candidate;
                sourcePage = candidatePage;
                break;
            }
        }
        Assert.NotNull(database);
        Assert.NotNull(sourcePage);
        var redactor = new ArchiveRedactor(includeProtectedIdentifiers: false);
        var page = redactor.Redact(sourcePage);
        var pageEntry = "database-city/pages/page-00000.json";
        var databaseId = redactor.Identifier(database.DatabaseId, "database");
        var index = new DatabaseCityArchiveIndex(
            new Dictionary<string, IReadOnlyDictionary<string, ArchivePageSeries>>(StringComparer.Ordinal)
            {
                [databaseId] = new Dictionary<string, ArchivePageSeries>(StringComparer.Ordinal)
                {
                    [DatabaseCityMetric.Cpu.ToString()] = new(
                        24, page.Objects.Count, [pageEntry]),
                },
            });
        var payloads = new[]
        {
            AtlasPayload(),
            new ArchivePayload(
                pageEntry, "database-city", ArchiveJson.SerializeCanonical(new[] { page }),
                page.Objects.Count, new ArchiveSourceStamp(At, At, null, "PointInTime")),
            new ArchivePayload(
                ArchiveSource.CityIndexEntry, "database-city", ArchiveJson.SerializeCanonical(index),
                page.Objects.Count, new ArchiveSourceStamp(At, At, null, "PointInTime")),
        };
        var manifest = ArchivePackageWriter.Preview(
            "1.0.0", At, new ArchiveTarget("opaque", "alias"),
            new ArchiveRedactionPolicy("default", false, false, false, []),
            ["atlas-v1", "canonical-json-v1", "database-city-v1", "uncompressed-container-v1"],
            [], new ArchiveLimits(1024 * 1024, 10, 100, 128, 10_000), payloads);
        var path = Path.Combine(_directory, "city-paging.ssca");
        ArchivePackageWriter.Write(
            path, manifest,
            payloads.ToDictionary(value => value.Name, value => value.Bytes, StringComparer.Ordinal),
            overwrite: false);

        using var source = ArchiveSource.Open(new ArchiveSourceOptions(_directory, Path.GetFileName(path)));
        var first = await source.GetDatabaseAsync(
            databaseId, DatabaseCityMetric.Cpu, 1, null, CancellationToken.None);
        Assert.NotNull(first);
        Assert.Single(first.Objects);
        Assert.NotNull(first.NextPageToken);
        await Assert.ThrowsAsync<DatabaseCityPageTokenException>(() =>
            source.GetDatabaseAsync(
                databaseId, DatabaseCityMetric.Cpu, 2, first.NextPageToken, CancellationToken.None));
        var second = await source.GetDatabaseAsync(
            databaseId, DatabaseCityMetric.Cpu, 1, first.NextPageToken, CancellationToken.None);
        Assert.NotNull(second);
        Assert.Single(second.Objects);
        Assert.NotEqual(first.Objects[0].ObjectId, second.Objects[0].ObjectId);
    }

    [Fact]
    public void Archive_source_rejects_undersized_nonfinal_page_chunks()
    {
        var firstName = "query-store/pages/page-00000.json";
        var secondName = "query-store/pages/page-00001.json";
        var index = new QueryStoreArchiveIndex(
            new Dictionary<string, string>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal),
            new Dictionary<string, ArchivePageSeries>(StringComparer.Ordinal)
            {
                ["cpu|*"] = new(2, 3, [firstName, secondName]),
            });
        var payloads = new[]
        {
            AtlasPayload(),
            new ArchivePayload(
                firstName, "query-store", ArchiveJson.SerializeCanonical(new[] { Family("one") }), 1,
                new ArchiveSourceStamp(At, At, null, "PointInTime")),
            new ArchivePayload(
                secondName, "query-store",
                ArchiveJson.SerializeCanonical(new[] { Family("two"), Family("three") }), 2,
                new ArchiveSourceStamp(At, At, null, "PointInTime")),
            new ArchivePayload(
                ArchiveSource.QueryStoreIndexEntry, "query-store",
                ArchiveJson.SerializeCanonical(index), 3,
                new ArchiveSourceStamp(At, At, null, "PointInTime")),
        };
        var manifest = ArchivePackageWriter.Preview(
            "1.0.0", At, new ArchiveTarget("opaque", "alias"),
            new ArchiveRedactionPolicy("default", false, false, false, []),
            ["atlas-v1", "canonical-json-v1", "query-store-v1", "uncompressed-container-v1"],
            [], new ArchiveLimits(1024 * 1024, 10, 100, 128, 10_000), payloads);
        var path = Path.Combine(_directory, "undersized-chunk.ssca");
        ArchivePackageWriter.Write(
            path, manifest,
            payloads.ToDictionary(value => value.Name, value => value.Bytes, StringComparer.Ordinal),
            overwrite: false);

        Assert.Throws<ArchiveValidationException>(() =>
            ArchiveSource.Open(new ArchiveSourceOptions(_directory, Path.GetFileName(path))));
    }

    private string WriteSimple(string name = "simple.ssca")
    {
        var built = Build([Payload()]);
        var path = Path.Combine(_directory, name);
        ArchivePackageWriter.Write(path, built.Manifest, built.Payloads, overwrite: false);
        return path;
    }

    private static ArchivePayload Payload() => new(
        "evidence/item.json", "evidence", ArchiveJson.SerializeCanonical(new { value = "42" }), 1,
        new ArchiveSourceStamp(At, At.AddMinutes(1), null, "PointInTime"));

    private static ArchivePayload AtlasPayload()
    {
        var snapshot = new AtlasSnapshotV1(
            "1.0", "snapshot", new AtlasTargetV1("opaque", "alias", "offline"), At, [], []);
        return new ArchivePayload(
            ArchiveSource.AtlasSnapshotEntry, "atlas", ArchiveJson.SerializeCanonical(snapshot), 0,
            new ArchiveSourceStamp(At, At, null, "PointInTime"));
    }

    private static QueryFamilySummaryV1 Family(string id) => new(
        id,
        "database",
        $"hash-{id}",
        null,
        new QueryTextDescriptorV1(QueryTextAvailability.Restricted, null, null, "omitted"),
        [],
        "1", "1", "1", "1", "1",
        At, At,
        new QueryStoreEvidenceV1(
            QueryStoreSource.Fixture, DataStatus.Available, At, At, "fixture", "aggregate"));

    private static (ArchiveManifest Manifest, IReadOnlyDictionary<string, byte[]> Payloads) Build(
        IReadOnlyList<ArchivePayload> payloads)
    {
        var limits = new ArchiveLimits(16 * 1024 * 1024, 100, 1000, 128, 10_000);
        var manifest = ArchivePackageWriter.Preview(
            "1.0.0", At, new ArchiveTarget("opaque", "alias"),
            new ArchiveRedactionPolicy("default", false, false, false, ["raw SQL"]),
            ["canonical-json-v1", "uncompressed-container-v1"], [], limits, payloads);
        return (manifest, payloads.ToDictionary(value => value.Name, value => value.Bytes, StringComparer.Ordinal));
    }

    private static void WriteRaw(string path, ArchiveManifest manifest, IReadOnlyList<byte[]> payloads)
    {
        var manifestBytes = ArchiveJson.SerializeCanonical(manifest);
        using var stream = File.Create(path);
        Span<byte> header = stackalloc byte[12];
        "SSCA\r\n\x1a\n"u8.CopyTo(header);
        BinaryPrimitives.WriteInt32BigEndian(header[8..], manifestBytes.Length);
        stream.Write(header);
        stream.Write(manifestBytes);
        foreach (var payload in payloads)
            stream.Write(payload);
    }

    private static readonly DateTimeOffset At = new(2026, 8, 17, 23, 59, 0, TimeSpan.Zero);

    private sealed record EnumHolder(DataStatus Status);

    public void Dispose()
    {
        if (Directory.Exists(_directory))
            Directory.Delete(_directory, recursive: true);
    }
}
