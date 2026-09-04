using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using SqlSimCity.Archive;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Archive.Tests;

public sealed class ArchiveCityQueryStoreMappingTests : IDisposable
{
    private const string SalesOwner = "fixture-target-primary/database/sales";
    private static readonly DateTimeOffset At = new(2026, 8, 17, 23, 59, 0, TimeSpan.Zero);
    private static readonly EvidenceV1 Evidence = new(
        EvidenceSource.Fixture, DataStatus.Available, At, At, "Synthetic archive mapping evidence.");
    private readonly string _directory = Path.Combine(
        AppContext.BaseDirectory, "archive-mapping-test-work", Guid.NewGuid().ToString("N"));

    public ArchiveCityQueryStoreMappingTests() => Directory.CreateDirectory(_directory);

    [Theory]
    [InlineData(false, "sales")]
    [InlineData(true, "sales")]
    [InlineData(false, SalesOwner)]
    [InlineData(true, SalesOwner)]
    [InlineData(false, "database-0123456789ab")]
    [InlineData(true, "database-0123456789ab")]
    [InlineData(false, null)]
    [InlineData(true, null)]
    [InlineData(false, "")]
    [InlineData(true, "")]
    public void Mapping_uses_the_query_family_database_redaction_and_is_idempotent(
        bool includeProtectedIdentifiers, string? queryStoreDatabaseId)
    {
        var redactor = new ArchiveRedactor(includeProtectedIdentifiers);
        var page = Page(SalesOwner) with { QueryStoreDatabaseId = queryStoreDatabaseId };
        var redacted = redactor.Redact(page);
        var expected = queryStoreDatabaseId is null
            ? null
            : redactor.Redact(Family(queryStoreDatabaseId)).DatabaseId;

        Assert.Equal(expected, redacted.QueryStoreDatabaseId);
        Assert.Equal(redactor.Identifier(SalesOwner, "database"), redacted.DatabaseId);
        Assert.Equal(queryStoreDatabaseId, page.QueryStoreDatabaseId);
        var repeated = redactor.Redact(redacted);
        Assert.Equal(redacted.QueryStoreDatabaseId, repeated.QueryStoreDatabaseId);
        Assert.Equal(redacted.DatabaseId, repeated.DatabaseId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Fixture_export_and_imported_city_pages_keep_the_query_store_binding(
        bool includeProtectedIdentifiers)
    {
        var path = await ExportFixtureAsync(includeProtectedIdentifiers);
        var redactor = new ArchiveRedactor(includeProtectedIdentifiers);
        var ownerId = redactor.Identifier(SalesOwner, "database");
        var queryStoreId = redactor.Identifier("sales", "database");
        using var package = ArchivePackageReader.Open(path, 4 * 1024 * 1024);
        var index = ArchiveJson.Deserialize<DatabaseCityArchiveIndex>(package.ReadEntry(ArchiveSource.CityIndexEntry));
        var series = index.Pages[ownerId][DatabaseCityMetric.Cpu.ToString()];
        var stored = Assert.Single(ArchiveJson.Deserialize<IReadOnlyList<DatabaseCityPageV1>>(
            package.ReadEntry(series.Entries[0])));
        Assert.Equal(ownerId, stored.DatabaseId);
        Assert.Equal(queryStoreId, stored.QueryStoreDatabaseId);
        Assert.NotEqual(stored.DatabaseId, stored.QueryStoreDatabaseId);

        using var source = Open(path);
        var families = await source.GetQueriesAsync(queryStoreId, "cpu", 200, null, CancellationToken.None);
        Assert.NotEmpty(families.Items);
        Assert.All(families.Items, family => Assert.Equal(stored.QueryStoreDatabaseId, family.DatabaseId));
        var objectIds = new List<string>();
        string? token = null;
        do
        {
            var page = await source.GetDatabaseAsync(ownerId, DatabaseCityMetric.Cpu, 2, token, CancellationToken.None);
            Assert.NotNull(page);
            Assert.Equal(ownerId, page.DatabaseId);
            Assert.Equal(queryStoreId, page.QueryStoreDatabaseId);
            objectIds.AddRange(page.Objects.Select(item => item.ObjectId));
            token = page.NextPageToken;
        } while (token is not null);
        Assert.True(objectIds.Count > 2);
        Assert.Equal(series.TotalCount, objectIds.Count);
        Assert.Equal(objectIds.Count, objectIds.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public async Task Pinned_legacy_city_pages_resolve_only_proven_captured_family_namespaces()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Fixtures", "format1-findings-before-removal.ssca");
        using var package = ArchivePackageReader.Open(path, 1024 * 1024);
        var index = ArchiveJson.Deserialize<DatabaseCityArchiveIndex>(package.ReadEntry(ArchiveSource.CityIndexEntry));
        var redactor = new ArchiveRedactor(includeProtectedIdentifiers: false);
        var salesOwner = redactor.Identifier(SalesOwner, "database");
        var salesQueryStore = redactor.Identifier("sales", "database");
        using var source = Open(path);
        foreach (var (ownerId, metrics) in index.Pages)
        {
            var entry = metrics[DatabaseCityMetric.Cpu.ToString()].Entries[0];
            using var json = JsonDocument.Parse(package.ReadEntry(entry));
            Assert.False(json.RootElement[0].TryGetProperty("queryStoreDatabaseId", out _));
            var page = await source.GetDatabaseAsync(ownerId, DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);
            Assert.NotNull(page);
            Assert.Equal(ownerId == salesOwner ? salesQueryStore : null, page.QueryStoreDatabaseId);
            Assert.True(page.HasQueryStoreDatabaseId);
        }
        var sales = await source.GetDatabaseAsync(salesOwner, DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);
        Assert.NotNull(sales);
        Assert.Equal(salesQueryStore, sales.QueryStoreDatabaseId);
        var captured = await source.GetQueriesAsync(salesQueryStore, "cpu", 1, null, CancellationToken.None);
        Assert.NotEmpty(captured.Items);
        Assert.Equal(sales.QueryStoreDatabaseId, captured.Items[0].DatabaseId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Explicit_null_mapping_survives_export_and_import_despite_same_name_families(
        bool includeProtectedIdentifiers)
    {
        var owners = new[] { "target-a/database/sales", "target-b/database/sales" };
        var path = WriteCityArchive(includeProtectedIdentifiers, owners, omitMapping: false);
        using var package = ArchivePackageReader.Open(path, 1024 * 1024);
        foreach (var entry in package.Manifest.Entries.Where(entry =>
                     entry.Name.StartsWith("database-city/pages/", StringComparison.Ordinal)))
        {
            using var json = JsonDocument.Parse(package.ReadEntry(entry.Name));
            Assert.Equal(JsonValueKind.Null, json.RootElement[0].GetProperty("queryStoreDatabaseId").ValueKind);
        }
        using var source = Open(path);
        var redactor = new ArchiveRedactor(includeProtectedIdentifiers);
        var captured = await source.GetQueriesAsync(
            redactor.Identifier("sales", "database"), "cpu", 1, null, CancellationToken.None);
        Assert.Single(captured.Items);
        foreach (var owner in owners)
        {
            var page = await source.GetDatabaseAsync(
                redactor.Identifier(owner, "database"), DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);
            Assert.NotNull(page);
            Assert.Null(page.QueryStoreDatabaseId);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Omitted_legacy_mapping_does_not_merge_ambiguous_same_name_owners(
        bool includeProtectedIdentifiers)
    {
        var owners = new[] { "target-a/database/sales", "target-b/database/sales" };
        var path = WriteCityArchive(includeProtectedIdentifiers, owners, omitMapping: true,
            referencedFamilyIds: ["family"]);
        using var source = Open(path);
        var redactor = new ArchiveRedactor(includeProtectedIdentifiers);
        var captured = await source.GetQueriesAsync(
            redactor.Identifier("sales", "database"), "cpu", 1, null, CancellationToken.None);
        var family = Assert.Single(captured.Items);
        var importedOwners = new List<string>();
        foreach (var owner in owners)
        {
            var ownerId = redactor.Identifier(owner, "database");
            var page = await source.GetDatabaseAsync(ownerId, DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);
            Assert.NotNull(page);
            Assert.Equal(ownerId, page.DatabaseId);
            Assert.Null(page.QueryStoreDatabaseId);
            Assert.NotEqual(family.DatabaseId, page.QueryStoreDatabaseId);
            importedOwners.Add(page.DatabaseId);
        }
        Assert.NotEqual(importedOwners[0], importedOwners[1]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Omitted_legacy_mapping_can_use_an_exact_owner_namespace_match(
        bool includeProtectedIdentifiers)
    {
        var path = WriteCityArchive(includeProtectedIdentifiers, [SalesOwner], omitMapping: true,
            familyDatabaseId: SalesOwner);
        var ownerId = new ArchiveRedactor(includeProtectedIdentifiers).Identifier(SalesOwner, "database");
        using var source = Open(path);
        var page = await source.GetDatabaseAsync(ownerId, DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);
        Assert.NotNull(page);
        Assert.Equal(ownerId, page.QueryStoreDatabaseId);
        var queries = await source.GetQueriesAsync(page.QueryStoreDatabaseId, "cpu", 1, null, CancellationToken.None);
        Assert.Equal(page.QueryStoreDatabaseId, Assert.Single(queries.Items).DatabaseId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Explicit_null_never_revives_even_with_an_exact_captured_owner_namespace(
        bool includeProtectedIdentifiers)
    {
        var path = WriteCityArchive(includeProtectedIdentifiers, [SalesOwner], omitMapping: false,
            familyDatabaseId: SalesOwner);
        var ownerId = new ArchiveRedactor(includeProtectedIdentifiers).Identifier(SalesOwner, "database");
        using var source = Open(path);
        var queries = await source.GetQueriesAsync(ownerId, "cpu", 1, null, CancellationToken.None);
        Assert.Equal(ownerId, Assert.Single(queries.Items).DatabaseId);
        var page = await source.GetDatabaseAsync(ownerId, DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);
        Assert.NotNull(page);
        Assert.Null(page.QueryStoreDatabaseId);
        Assert.True(page.HasQueryStoreDatabaseId);
    }

    [Theory]
    [InlineData(false, "missing-atlas")]
    [InlineData(true, "missing-atlas")]
    [InlineData(false, "duplicate-atlas")]
    [InlineData(true, "duplicate-atlas")]
    [InlineData(false, "missing-city")]
    [InlineData(true, "missing-city")]
    [InlineData(false, "duplicate-city")]
    [InlineData(true, "duplicate-city")]
    public async Task Legacy_exact_namespace_requires_a_unique_atlas_city_association(
        bool includeProtectedIdentifiers, string associationFailure)
    {
        var path = WriteCityArchive(includeProtectedIdentifiers, [SalesOwner], omitMapping: true,
            familyDatabaseId: SalesOwner, associationFailure: associationFailure);
        var ownerId = new ArchiveRedactor(includeProtectedIdentifiers).Identifier(SalesOwner, "database");
        using var source = Open(path);
        Assert.Single((await source.GetQueriesAsync(ownerId, "cpu", 1, null, CancellationToken.None)).Items);
        var page = await source.GetDatabaseAsync(ownerId, DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);
        Assert.NotNull(page);
        Assert.Null(page.QueryStoreDatabaseId);
        Assert.True(page.HasQueryStoreDatabaseId);
    }

    [Fact]
    public async Task Rewritten_pinned_legacy_exact_owner_namespace_survives_imported_paging()
    {
        var path = RewritePinnedWithExactOwnerNamespace();
        var ownerId = new ArchiveRedactor(includeProtectedIdentifiers: false).Identifier(SalesOwner, "database");
        using var package = ArchivePackageReader.Open(path, 1024 * 1024);
        var index = ArchiveJson.Deserialize<DatabaseCityArchiveIndex>(package.ReadEntry(ArchiveSource.CityIndexEntry));
        using var stored = JsonDocument.Parse(package.ReadEntry(index.Pages[ownerId]["Cpu"].Entries[0]));
        Assert.False(stored.RootElement[0].TryGetProperty("queryStoreDatabaseId", out _));
        using var source = Open(path);
        var families = await source.GetQueriesAsync(ownerId, "cpu", 200, null, CancellationToken.None);
        Assert.NotEmpty(families.Items);
        Assert.All(families.Items, family => Assert.Equal(ownerId, family.DatabaseId));
        string? token = null;
        var pages = 0;
        do
        {
            var page = await source.GetDatabaseAsync(ownerId, DatabaseCityMetric.Cpu, 2, token, CancellationToken.None);
            Assert.NotNull(page);
            Assert.Equal(ownerId, page.QueryStoreDatabaseId);
            Assert.True(page.HasQueryStoreDatabaseId);
            token = page.NextPageToken;
            pages++;
        } while (token is not null);
        Assert.True(pages > 1);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task Legacy_captured_family_identity_can_prove_a_distinct_query_store_namespace(
        bool includeProtectedIdentifiers, bool writeUnredactedPayloadIds)
    {
        var path = WriteCityArchive(includeProtectedIdentifiers, [SalesOwner], omitMapping: true,
            referencedFamilyIds: ["family"], writeUnredactedPayloadIds: writeUnredactedPayloadIds);
        var redactor = new ArchiveRedactor(includeProtectedIdentifiers);
        using var source = Open(path);
        var page = await source.GetDatabaseAsync(
            redactor.Identifier(SalesOwner, "database"), DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);
        Assert.NotNull(page);
        Assert.NotEqual(page.DatabaseId, page.QueryStoreDatabaseId);
        Assert.Equal(redactor.Identifier("sales", "database"), page.QueryStoreDatabaseId);
        var queries = await source.GetQueriesAsync(page.QueryStoreDatabaseId, "cpu", 1, null, CancellationToken.None);
        Assert.Equal(Assert.Single(page.TopQueryFamilies).FamilyId, Assert.Single(queries.Items).FamilyId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Legacy_unknown_family_references_cannot_prove_a_namespace(bool includeProtectedIdentifiers)
    {
        var path = WriteCityArchive(includeProtectedIdentifiers, [SalesOwner], omitMapping: true,
            referencedFamilyIds: ["unknown-family"]);
        using var source = Open(path);
        var page = await source.GetDatabaseAsync(
            new ArchiveRedactor(includeProtectedIdentifiers).Identifier(SalesOwner, "database"),
            DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);
        Assert.NotNull(page);
        Assert.Null(page.QueryStoreDatabaseId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Legacy_conflicting_captured_family_namespaces_remain_unmapped(bool includeProtectedIdentifiers)
    {
        var path = WriteCityArchive(includeProtectedIdentifiers, [SalesOwner], omitMapping: true,
            referencedFamilyIds: ["family", "other-family"], extraFamilyDatabaseId: "other-sales");
        using var source = Open(path);
        var page = await source.GetDatabaseAsync(
            new ArchiveRedactor(includeProtectedIdentifiers).Identifier(SalesOwner, "database"),
            DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);
        Assert.NotNull(page);
        Assert.Equal(2, page.TopQueryFamilies.Count);
        Assert.Null(page.QueryStoreDatabaseId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Legacy_owner_cannot_claim_a_namespace_explicitly_owned_by_another_city(
        bool includeProtectedIdentifiers)
    {
        var otherOwner = "another-target/database/sales";
        var path = WriteCityArchive(includeProtectedIdentifiers, [SalesOwner, otherOwner], omitMapping: true,
            referencedFamilyIds: ["family"], explicitMappings: new Dictionary<string, string?>(StringComparer.Ordinal)
            {
                [otherOwner] = "sales",
            });
        var redactor = new ArchiveRedactor(includeProtectedIdentifiers);
        using var source = Open(path);
        var legacy = await source.GetDatabaseAsync(
            redactor.Identifier(SalesOwner, "database"), DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);
        var explicitPage = await source.GetDatabaseAsync(
            redactor.Identifier(otherOwner, "database"), DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);
        Assert.NotNull(legacy);
        Assert.NotNull(explicitPage);
        Assert.Null(legacy.QueryStoreDatabaseId);
        Assert.Equal(redactor.Identifier("sales", "database"), explicitPage.QueryStoreDatabaseId);
    }

    private async Task<string> ExportFixtureAsync(bool includeProtectedIdentifiers)
    {
        var (manifest, payloads) = await FixtureArchiveBuilder.BuildAsync(
            At, "mapping-fixture", includeProtectedIdentifiers, CancellationToken.None);
        var path = Path.Combine(_directory, "fixture.ssca");
        ArchivePackageWriter.Write(path, manifest, payloads, overwrite: false);
        return path;
    }

    private string WriteCityArchive(
        bool includeProtectedIdentifiers,
        string[] owners,
        bool omitMapping,
        string familyDatabaseId = "sales",
        string? associationFailure = null,
        string[]? referencedFamilyIds = null,
        string? extraFamilyDatabaseId = null,
        Dictionary<string, string?>? explicitMappings = null,
        bool writeUnredactedPayloadIds = false)
    {
        var redactor = new ArchiveRedactor(includeProtectedIdentifiers || writeUnredactedPayloadIds);
        var indexRedactor = new ArchiveRedactor(includeProtectedIdentifiers);
        var payloads = new List<ArchivePayload>();
        var cityPages = new Dictionary<string, IReadOnlyDictionary<string, ArchivePageSeries>>(StringComparer.Ordinal);
        for (var index = 0; index < owners.Length; index++)
        {
            var hasExplicitMapping = explicitMappings?.ContainsKey(owners[index]) == true;
            var page = redactor.Redact(Page(owners[index]) with
            {
                QueryStoreDatabaseId = hasExplicitMapping ? explicitMappings![owners[index]] : null,
                TopQueryFamilies = (referencedFamilyIds ?? []).Select(ReferencedFamily).ToArray(),
            });
            var json = JsonSerializer.SerializeToNode(page, ArchiveJson.SerializerOptions)!.AsObject();
            if (omitMapping && !hasExplicitMapping)
                Assert.True(json.Remove("queryStoreDatabaseId"));
            var name = $"database-city/pages/page-{index.ToString(CultureInfo.InvariantCulture)}.json";
            Add(payloads, name, "database-city", new JsonArray(json), 0);
            cityPages.Add(indexRedactor.Identifier(page.DatabaseId, "database"),
                new Dictionary<string, ArchivePageSeries>(StringComparer.Ordinal)
            {
                [DatabaseCityMetric.Cpu.ToString()] = new(24, 0, [name]),
            });
        }
        var families = new List<QueryFamilySummaryV1> { redactor.Redact(Family(familyDatabaseId)) };
        if (extraFamilyDatabaseId is not null)
            families.Add(redactor.Redact(Family(extraFamilyDatabaseId) with { FamilyId = "other-family" }));
        const string queryPage = "query-store/pages/all.json";
        Add(payloads, queryPage, "query-store", families, families.Count);
        var metricPages = new Dictionary<string, ArchivePageSeries>(StringComparer.Ordinal)
        {
            ["cpu|*"] = new(families.Count, families.Count, [queryPage]),
        };
        var namespaceIndex = 0;
        foreach (var group in families.GroupBy(family => family.DatabaseId, StringComparer.Ordinal))
        {
            var name = $"query-store/pages/namespace-{namespaceIndex++}.json";
            var items = group.ToArray();
            Add(payloads, name, "query-store", items, items.Length);
            metricPages.Add($"cpu|{indexRedactor.Identifier(group.Key, "database")}",
                new ArchivePageSeries(items.Length, items.Length, [name]));
        }
        Add(payloads, ArchiveSource.QueryStoreIndexEntry, "query-store", new QueryStoreArchiveIndex(
            new Dictionary<string, string>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal), metricPages), 1);
        Add(payloads, ArchiveSource.CityIndexEntry, "database-city", new DatabaseCityArchiveIndex(cityPages), owners.Length);
        var atlas = new FixtureAtlasSnapshotSource().GetCurrent();
        var template = atlas.Databases[0];
        var atlasDatabases = owners.Select(owner => template with { DatabaseId = owner, Name = "Sales" }).ToArray();
        if (associationFailure == "missing-atlas")
            atlasDatabases = [];
        else if (associationFailure == "duplicate-atlas")
            atlasDatabases = [atlasDatabases[0], atlasDatabases[0]];
        Add(payloads, ArchiveSource.AtlasSnapshotEntry, "atlas", redactor.Redact(atlas with
        {
            Target = new AtlasTargetV1("target", "mapping", "fixture"),
            Databases = atlasDatabases,
            Edges = [],
        }, "mapping"), atlasDatabases.Length);
        var citySummaries = owners.Select(owner => new DatabaseCitySummaryV1(
            owner, "Sales", "0", "0", "0", MeasurementStatus.Known, Evidence)).ToArray();
        if (associationFailure == "missing-city")
            citySummaries = [];
        else if (associationFailure == "duplicate-city")
            citySummaries = [citySummaries[0], citySummaries[0]];
        Add(payloads, ArchiveSource.CitySummariesEntry, "database-city",
            redactor.Redact(new DatabaseCitySummarySnapshotV1("1.0", At, citySummaries)), citySummaries.Length);
        var manifest = ArchivePackageWriter.Preview(
            "1.0", At, new ArchiveTarget("target", "mapping"),
            new ArchiveRedactionPolicy("mapping-test", includeProtectedIdentifiers, false, false, []),
            ["atlas-v1", "database-city-v1", "query-store-v1", "canonical-json-v1", "uncompressed-container-v1"],
            ["paged-query-store"], new ArchiveLimits(1024 * 1024, 100, 1000, 128, 10_000), payloads);
        var path = Path.Combine(_directory, "mapping.ssca");
        ArchivePackageWriter.Write(path, manifest,
            payloads.ToDictionary(payload => payload.Name, payload => payload.Bytes, StringComparer.Ordinal), overwrite: false);
        return path;
    }

    private string RewritePinnedWithExactOwnerNamespace()
    {
        var pinned = Path.Combine(AppContext.BaseDirectory, "Fixtures", "format1-findings-before-removal.ssca");
        using var package = ArchivePackageReader.Open(pinned, 1024 * 1024);
        var redactor = new ArchiveRedactor(includeProtectedIdentifiers: false);
        var oldNamespace = redactor.Identifier("sales", "database");
        var ownerId = redactor.Identifier(SalesOwner, "database");
        var payloads = new List<ArchivePayload>();
        foreach (var entry in package.Manifest.Entries)
        {
            var bytes = package.ReadEntry(entry.Name);
            if (entry.Name == ArchiveSource.QueryStoreIndexEntry)
            {
                var index = ArchiveJson.Deserialize<QueryStoreArchiveIndex>(bytes);
                bytes = ArchiveJson.SerializeCanonical(index with
                {
                    MetricPages = index.MetricPages.ToDictionary(
                        pair => pair.Key.EndsWith("|" + oldNamespace, StringComparison.Ordinal)
                            ? pair.Key[..pair.Key.IndexOf('|')] + "|" + ownerId
                            : pair.Key,
                        pair => pair.Value, StringComparer.Ordinal),
                });
            }
            else if (entry.Section == "query-store")
            {
                var node = JsonNode.Parse(bytes)!;
                ReplaceCapturedDatabaseId(node, oldNamespace, ownerId);
                bytes = ArchiveJson.SerializeCanonical(node);
            }
            payloads.Add(new ArchivePayload(entry.Name, entry.Section, bytes, entry.RecordCount, entry.Source));
        }
        var original = package.Manifest;
        var manifest = ArchivePackageWriter.Preview(
            original.ProducerVersion, original.CreatedAt, original.Target, original.Redaction,
            original.Features, original.Capabilities, original.Limits, payloads);
        var path = Path.Combine(_directory, "legacy-exact-owner.ssca");
        ArchivePackageWriter.Write(path, manifest,
            payloads.ToDictionary(payload => payload.Name, payload => payload.Bytes, StringComparer.Ordinal), overwrite: false);
        return path;
    }

    private static void ReplaceCapturedDatabaseId(JsonNode node, string oldId, string newId)
    {
        if (node is JsonObject jsonObject)
        {
            foreach (var property in jsonObject.ToArray())
            {
                if (property.Key == "databaseId" && property.Value?.GetValue<string>() == oldId)
                    jsonObject[property.Key] = newId;
                else if (property.Value is not null)
                    ReplaceCapturedDatabaseId(property.Value, oldId, newId);
            }
        }
        else if (node is JsonArray array)
        {
            foreach (var item in array)
            {
                if (item is not null)
                    ReplaceCapturedDatabaseId(item, oldId, newId);
            }
        }
    }

    private static void Add<T>(List<ArchivePayload> payloads, string name, string section, T value, int count) =>
        payloads.Add(new ArchivePayload(name, section, ArchiveJson.SerializeCanonical(value), count,
            new ArchiveSourceStamp(At, At, null, "PointInTime")));

    private static DatabaseCityPageV1 Page(string ownerId) => new(
        "1.0", ownerId, "Sales", DatabaseCityMetric.Cpu, 24, null, "0", [], [], [],
        new DatabaseCityWorkloadAggregateV1("0", "0", "0", "0", "0", "0", Evidence), [], Evidence);

    private static QueryFamilySummaryV1 Family(string databaseId) => new(
        "family", databaseId, "hash", null,
        new QueryTextDescriptorV1(QueryTextAvailability.Restricted, null, null, "omitted"),
        [], "1", "1", "1", "1", "1", At, At,
        new QueryStoreEvidenceV1(QueryStoreSource.Fixture, DataStatus.Available, At, At, "fixture", "aggregate"));

    private static DatabaseCityQueryFamilyV1 ReferencedFamily(string familyId) => new(
        familyId, "hash", "1", "1", "1", "1", "1",
        new Dictionary<string, string>(StringComparer.Ordinal), [],
        QueryAttributionConfidence.Confirmed, "Captured family identity.", Evidence);

    private static ArchiveSource Open(string path) =>
        ArchiveSource.Open(new ArchiveSourceOptions(Path.GetDirectoryName(path)!, Path.GetFileName(path)));

    public void Dispose() => Directory.Delete(_directory, recursive: true);
}
