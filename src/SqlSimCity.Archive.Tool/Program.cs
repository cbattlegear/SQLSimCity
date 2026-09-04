using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SqlSimCity.Archive;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Negotiation;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

return await ArchiveTool.RunAsync(args, CancellationToken.None);

internal static class ArchiveTool
{
    public static async Task<int> RunAsync(string[] args, CancellationToken cancellationToken)
    {
        try
        {
            if (args.Length == 0)
                return Usage();
            return args[0] switch
            {
                "preview-fixture" => await PreviewOrExportAsync(args[1..], write: false, cancellationToken),
                "export-fixture" => await PreviewOrExportAsync(args[1..], write: true, cancellationToken),
                "validate" => Validate(args[1..]),
                "smoke-import" => await SmokeImportAsync(args[1..], cancellationToken),
                _ => Usage(),
            };
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            Console.Error.WriteLine($"archive-tool: {exception.Message}");
            return 2;
        }
    }

    private static async Task<int> PreviewOrExportAsync(
        string[] args,
        bool write,
        CancellationToken cancellationToken)
    {
        var output = Value(args, "--output");
        if (write && string.IsNullOrWhiteSpace(output))
            throw new ArgumentException("--output is required for export-fixture.");
        var overwrite = args.Contains("--overwrite", StringComparer.Ordinal);
        var includeIdentifiers = args.Contains("--protected-identifiers", StringComparer.Ordinal);
        var createdAt = DateTimeOffset.Parse(
            Value(args, "--created-at") ?? "2026-08-17T23:59:00Z",
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal).ToUniversalTime();
        var alias = Value(args, "--display-alias") ?? "Imported SQL Server";
        if (alias.Length is < 1 or > 256)
            throw new ArgumentException("--display-alias must contain between 1 and 256 characters.");
        var built = await FixtureArchiveBuilder.BuildAsync(
            createdAt, alias, includeIdentifiers, cancellationToken);
        Console.WriteLine(JsonSerializer.Serialize(built.Manifest, ArchiveJson.SerializerOptions));
        if (write)
        {
            ArchivePackageWriter.Write(output!, built.Manifest, built.Payloads, overwrite);
            Console.Error.WriteLine($"Wrote {output} ({new FileInfo(output!).Length} bytes).");
        }
        return 0;
    }

    private static int Validate(string[] args)
    {
        if (args.Length != 1)
            throw new ArgumentException("validate requires exactly one archive path.");
        var fullPath = Path.GetFullPath(args[0]);
        using var source = ArchiveSource.Open(new ArchiveSourceOptions(
            Path.GetDirectoryName(fullPath)
                ?? throw new ArgumentException("The archive path has no parent directory."),
            Path.GetFileName(fullPath)));
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            valid = true,
            source.Info.SchemaVersion,
            source.Info.ProducerVersion,
            source.Info.CreatedAt,
            entries = source.Info.EntryCount,
            bytes = source.Info.ArchiveBytes,
        }, ArchiveJson.SerializerOptions));
        return 0;
    }

    private static async Task<int> SmokeImportAsync(string[] args, CancellationToken cancellationToken)
    {
        if (args.Length != 1)
            throw new ArgumentException("smoke-import requires exactly one archive path.");
        var fullPath = Path.GetFullPath(args[0]);
        using var source = ArchiveSource.Open(new ArchiveSourceOptions(
            Path.GetDirectoryName(fullPath)
                ?? throw new ArgumentException("The archive path has no parent directory."),
            Path.GetFileName(fullPath)));
        var queries = await source.GetQueriesAsync(null, "cpu", 1, null, cancellationToken);
        var city = await source.GetSummariesAsync(cancellationToken);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            imported = true,
            source = source.Info.Source,
            atlasDatabases = source.GetCurrent().Databases.Count,
            queryFamiliesRead = queries.Items.Count,
            cityDatabases = city.Databases.Count,
            staticLive = source.GetCurrentResponse().Collector.State == SamplerRunState.Stopped,
        }, ArchiveJson.SerializerOptions));
        return 0;
    }

    private static string? Value(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static int Usage()
    {
        Console.Error.WriteLine(
            "Usage:\n" +
            "  archive-tool preview-fixture [--created-at UTC] [--display-alias ALIAS] [--protected-identifiers]\n" +
            "  archive-tool export-fixture --output FILE [--overwrite] [--created-at UTC] [--display-alias ALIAS] [--protected-identifiers]\n" +
            "  archive-tool validate FILE\n" +
            "  archive-tool smoke-import FILE");
        return 1;
    }
}

internal static class FixtureArchiveBuilder
{
    private const int QueryChunkSize = 200;

    public static async Task<(ArchiveManifest Manifest, IReadOnlyDictionary<string, byte[]> Payloads)> BuildAsync(
        DateTimeOffset createdAt,
        string displayAlias,
        bool includeProtectedIdentifiers,
        CancellationToken cancellationToken)
    {
        var redactor = new ArchiveRedactor(includeProtectedIdentifiers);
        var atlasSource = new FixtureAtlasSnapshotSource();
        var querySource = new FixtureQueryStoreHistorySource();
        var citySource = new FixtureDatabaseCitySource();
        var sourceAtlas = atlasSource.GetCurrent();
        var atlas = redactor.Redact(sourceAtlas, displayAlias);
        var sourceCapabilities = await BuildCapabilitiesAsync(createdAt, cancellationToken);
        sourceCapabilities = sourceCapabilities with
        {
            Targets = sourceCapabilities.Targets.Take(1)
                .Select(target => target with { TargetId = sourceAtlas.Target.TargetId })
                .ToArray(),
        };
        var capabilities = redactor.Redact(sourceCapabilities);
        var liveSnapshot = await new FixtureLiveIncidentCollector(new FixedTimeProvider(createdAt))
            .CollectAsync(1, cancellationToken);
        var live = redactor.Redact(new LiveIncidentResponseV1(
            liveSnapshot,
            new LiveCollectorStatusV1(SamplerRunState.Stopped, 1, createdAt, createdAt, 0, null,
                "Fixture export captured one point-in-time sample.", 0, 0)));

        var payloads = new List<ArchivePayload>();
        Add(payloads, ArchiveSource.AtlasSnapshotEntry, "atlas", atlas, atlas.Databases.Count, atlas.GeneratedAt, atlas.Collection?.StaleAfter);
        Add(payloads, ArchiveSource.AtlasStatusEntry, "atlas", atlasSource.GetStatus(), 1, atlas.GeneratedAt, atlas.Collection?.StaleAfter);
        Add(payloads, ArchiveSource.CapabilitiesEntry, "capabilities", capabilities, capabilities.Targets.Count, capabilities.GeneratedAt, null);
        Add(payloads, ArchiveSource.LiveResponseEntry, "live", live, live.Snapshot?.Requests.Count ?? 0, live.Snapshot?.SourceTimestamp, live.Snapshot?.FreshUntil);

        var queryIndex = await BuildQueryStoreAsync(querySource, redactor, payloads, cancellationToken);
        Add(payloads, ArchiveSource.QueryStoreIndexEntry, "query-store", queryIndex,
            queryIndex.FamilyEntries.Count, createdAt, null);
        var queryStatus = redactor.Redact(await querySource.GetStatusAsync(cancellationToken));
        Add(payloads, ArchiveSource.QueryStoreStatusEntry, "query-store", queryStatus,
            queryStatus.Databases.Count, queryStatus.LastPublishedAt, null);

        var sourceSummaries = await citySource.GetSummariesAsync(cancellationToken);
        var summaries = redactor.Redact(sourceSummaries);
        Add(payloads, ArchiveSource.CitySummariesEntry, "database-city", summaries,
            summaries.Databases.Count, summaries.GeneratedAt, null);
        var cityIndex = await BuildCityAsync(citySource, sourceSummaries, redactor, payloads, cancellationToken);
        Add(payloads, ArchiveSource.CityIndexEntry, "database-city", cityIndex,
            cityIndex.Pages.Count, summaries.GeneratedAt, null);

        var payloadMap = payloads.ToDictionary(payload => payload.Name, payload => payload.Bytes, StringComparer.Ordinal);
        var redaction = new ArchiveRedactionPolicy(
            "sqlsimcity-default-v1",
            includeProtectedIdentifiers,
            RawSqlIncluded: false,
            RawShowplanXmlIncluded: false,
            [
                "credentials", "authentication identifiers", "raw SQL", "raw Showplan XML",
                "host/login/program/client addresses", "secret paths",
                includeProtectedIdentifiers ? "none (protected identifiers explicitly included)" : "database/schema/object/index names",
            ]);
        var limits = new ArchiveLimits(
            256L * 1024 * 1024, 20_000, 1_000_000, 128, 120_000);
        var manifest = ArchivePackageWriter.Preview(
            typeof(ArchiveTool).Assembly.GetName().Version?.ToString() ?? "0.0.0",
            createdAt,
            new ArchiveTarget(HashName($"target:{atlas.Target.TargetId}"), displayAlias),
            redaction,
            [
                "atlas-v1", "capabilities-v1", "query-store-v1", "database-city-v1",
                "live-point-in-time-v1", "canonical-json-v1",
                "uncompressed-container-v1",
            ],
            ["paged-query-store", "normalized-plans", "static-live-sample"],
            limits,
            payloads);
        return (manifest, payloadMap);
    }

    private static async Task<QueryStoreArchiveIndex> BuildQueryStoreAsync(
        FixtureQueryStoreHistorySource source,
        ArchiveRedactor redactor,
        List<ArchivePayload> payloads,
        CancellationToken cancellationToken)
    {
        var familyEntries = new Dictionary<string, string>(StringComparer.Ordinal);
        var planEntries = new Dictionary<string, string>(StringComparer.Ordinal);
        var pages = new Dictionary<string, ArchivePageSeries>(StringComparer.Ordinal);
        var allFamilies = new Dictionary<string, QueryFamilySummaryV1>(StringComparer.Ordinal);
        foreach (var metric in new[] { "cpu", "executions", "duration", "reads", "waits" })
        {
            var metricFamilies = await ReadAllAsync(source, null, metric, cancellationToken);
            foreach (var family in metricFamilies)
                allFamilies.TryAdd(family.FamilyId, family);
            AddQueryPages(metric + "|*", metricFamilies, redactor, payloads, pages);
            foreach (var databaseId in metricFamilies.Select(family => family.DatabaseId).Distinct(StringComparer.Ordinal))
                AddQueryPages(metric + "|" + redactor.Identifier(databaseId, "database"),
                    metricFamilies.Where(family => family.DatabaseId == databaseId).ToArray(),
                    redactor, payloads, pages);
        }
        foreach (var summary in allFamilies.Values.OrderBy(value => value.FamilyId, StringComparer.Ordinal))
        {
            var detail = await source.GetFamilyAsync(summary.FamilyId, cancellationToken)
                ?? throw new InvalidOperationException($"Fixture family '{summary.FamilyId}' disappeared.");
            var familyEntry = $"query-store/families/{HashName(summary.FamilyId)}.json";
            var redactedDetail = redactor.Redact(detail);
            Add(payloads, familyEntry, "query-store", redactedDetail, 1,
                summary.LastObservedAt, summary.Evidence.FreshUntil,
                redactedDetail.Runtime.Count == 0 ? null : redactedDetail.Runtime[0].EpochId);
            familyEntries.Add(redactor.Identifier(summary.FamilyId, "family"), familyEntry);
            foreach (var planSummary in detail.Plans)
            {
                if (planEntries.ContainsKey(planSummary.PlanId))
                    continue;
                var plan = await source.GetPlanAsync(planSummary.PlanId, cancellationToken);
                if (plan is null)
                    continue;
                var planEntry = $"query-store/plans/{HashName(plan.PlanId)}.json";
                Add(payloads, planEntry, "query-store", redactor.Redact(plan), plan.Nodes.Count,
                    plan.Evidence.ObservedAt, plan.Evidence.FreshUntil);
                planEntries.Add(redactor.Identifier(plan.PlanId, "plan"), planEntry);
            }
        }
        return new QueryStoreArchiveIndex(familyEntries, planEntries, pages);
    }

    private static async Task<DatabaseCityArchiveIndex> BuildCityAsync(
        FixtureDatabaseCitySource source,
        DatabaseCitySummarySnapshotV1 summaries,
        ArchiveRedactor redactor,
        List<ArchivePayload> payloads,
        CancellationToken cancellationToken)
    {
        var databases = new Dictionary<string, IReadOnlyDictionary<string, ArchivePageSeries>>(StringComparer.Ordinal);
        foreach (var database in summaries.Databases)
        {
            var metrics = new Dictionary<string, ArchivePageSeries>(StringComparer.Ordinal);
            foreach (var metric in Enum.GetValues<DatabaseCityMetric>())
            {
                var names = new List<string>();
                long totalObjects = 0;
                string? token = null;
                do
                {
                    var page = await source.GetDatabaseAsync(database.DatabaseId, metric, 24, token, cancellationToken);
                    if (page is null)
                        break;
                    var name = $"database-city/pages/{HashName(database.DatabaseId)}-{metric.ToString().ToLowerInvariant()}-{names.Count:D5}.json";
                    var redactedPage = redactor.Redact(page);
                    Add(payloads, name, "database-city", new[] { redactedPage }, page.Objects.Count,
                        page.Evidence.ObservedAt, page.Evidence.FreshUntil,
                        redactedPage.Objects.Select(value => value.DirectActivity.ResetEpochToken)
                            .FirstOrDefault(value => value is not null));
                    names.Add(name);
                    totalObjects += page.Objects.Count;
                    token = page.NextPageToken;
                } while (token is not null);
                if (names.Count > 0)
                    metrics.Add(metric.ToString(), new ArchivePageSeries(24, totalObjects, names));
            }
            if (metrics.Count > 0)
                databases.Add(redactor.Identifier(database.DatabaseId, "database"), metrics);
        }
        return new DatabaseCityArchiveIndex(databases);
    }

    private static async Task<IReadOnlyList<QueryFamilySummaryV1>> ReadAllAsync(
        FixtureQueryStoreHistorySource source,
        string? databaseId,
        string metric,
        CancellationToken cancellationToken)
    {
        var output = new List<QueryFamilySummaryV1>();
        string? token = null;
        do
        {
            var page = await source.GetQueriesAsync(databaseId, metric, QueryChunkSize, token, cancellationToken);
            output.AddRange(page.Items);
            token = page.NextPageToken;
        } while (token is not null);
        return output;
    }

    private static void AddQueryPages(
        string key,
        IReadOnlyList<QueryFamilySummaryV1> families,
        ArchiveRedactor redactor,
        List<ArchivePayload> payloads,
        Dictionary<string, ArchivePageSeries> index)
    {
        var names = new List<string>();
        for (var offset = 0; offset < families.Count; offset += QueryChunkSize)
        {
            var chunk = families.Skip(offset).Take(QueryChunkSize).Select(redactor.Redact).ToArray();
            var name = $"query-store/pages/{HashName(key)}-{names.Count:D5}.json";
            Add(payloads, name, "query-store", chunk, chunk.Length,
                chunk.FirstOrDefault()?.FirstObservedAt, chunk.LastOrDefault()?.Evidence.FreshUntil);
            names.Add(name);
        }
        index.Add(key, new ArchivePageSeries(QueryChunkSize, families.Count, names));
    }

    private static async Task<CapabilitiesSnapshotV1> BuildCapabilitiesAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var profiles = new List<TargetCapabilityProfileV1>();
        foreach (var targetId in FixtureProbeExecutor.GetKnownTargetIds())
        {
            profiles.Add(await new CapabilityNegotiator(
                    new FixtureProbeExecutor(targetId), new FixedTimeProvider(now))
                .NegotiateAsync(new CapabilityNegotiationRequest(targetId, "db:atlas-sales"), cancellationToken));
        }
        return new CapabilitiesSnapshotV1("1", now, profiles);
    }

    private static void Add<T>(
        List<ArchivePayload> payloads,
        string name,
        string section,
        T value,
        long records,
        DateTimeOffset? observedAt,
        DateTimeOffset? freshUntil,
        string? resetEpoch = null)
    {
        payloads.Add(new ArchivePayload(
            name, section, ArchiveJson.SerializeCanonical(value), records,
            new ArchiveSourceStamp(observedAt, freshUntil, resetEpoch, "PointInTime")));
    }

    private static string HashName(string value) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..24];
}

internal sealed class FixedTimeProvider(DateTimeOffset value) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => value;
}
