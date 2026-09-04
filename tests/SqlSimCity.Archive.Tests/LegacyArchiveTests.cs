using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using SqlSimCity.Archive;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Archive.Tests;

public sealed class LegacyArchiveTests : IDisposable
{
    private const string SnapshotEntry = "findings/snapshot.json";
    private const string DescriptorEntry = "findings/descriptor.json";
    private readonly string _directory = Path.Combine(
        AppContext.BaseDirectory, "legacy-archive-test-work", Guid.NewGuid().ToString("N"));

    public LegacyArchiveTests() => Directory.CreateDirectory(_directory);

    private static string FixturePath => Path.Combine(
        AppContext.BaseDirectory, "Fixtures", "format1-findings-before-removal.ssca");

    [Fact]
    public async Task Pinned_pre_removal_archive_contains_findings_and_reads_retained_evidence()
    {
        Assert.Equal("5475d64784049c3609b0e395b1585dd775642df9025e3a9fece8e1399580ae68",
            Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(FixturePath))));
        using var package = ArchivePackageReader.Open(FixturePath, 1024 * 1024);
        Assert.Equal("1.0", package.Manifest.SchemaVersion);
        Assert.Contains("findings-evidence-v1", package.Manifest.Features);
        Assert.Contains("findings", package.Manifest.IncludedSections);
        Assert.False(package.Manifest.Redaction.ProtectedIdentifiersIncluded);
        using var snapshot = JsonDocument.Parse(package.ReadEntry("findings/snapshot.json"));
        using var descriptor = JsonDocument.Parse(package.ReadEntry("findings/descriptor.json"));
        Assert.Equal(7, snapshot.RootElement.GetProperty("export").GetProperty("findings").GetArrayLength());
        Assert.Equal("ReevaluateImportedEvidence", descriptor.RootElement.GetProperty("mode").GetString());
        Assert.Equal(15, descriptor.RootElement.GetProperty("ruleVersions").EnumerateObject().Count());

        using var source = ArchiveSource.Open(new ArchiveSourceOptions(
            Path.GetDirectoryName(FixturePath)!, Path.GetFileName(FixturePath)));
        Assert.DoesNotContain("offline-findings-reevaluation", source.Info.Capabilities);
        Assert.NotEmpty(source.GetCurrent().Databases);
        Assert.NotEmpty(source.GetCurrent().Edges);
        Assert.All(source.GetCurrent().Edges,
            edge => Assert.Equal(EvidenceSource.ImportedArchive, edge.Evidence.Source));
        Assert.NotEmpty(((ICapabilitiesSource)source).GetCurrent().Targets);
        var queries = await source.GetQueriesAsync(null, "cpu", 1, null, CancellationToken.None);
        var family = Assert.Single(queries.Items);
        Assert.Equal(QueryStoreSource.ImportedArchive, family.Evidence.Source);
        var detail = await source.GetFamilyAsync(family.FamilyId, CancellationToken.None);
        Assert.NotNull(detail);
        Assert.NotEmpty(detail.Runtime);
        Assert.NotEmpty(detail.Plans);
        var plan = await source.GetPlanAsync(detail.Plans[0].PlanId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.NotEmpty(plan.Nodes);
        var cities = await source.GetSummariesAsync(CancellationToken.None);
        Assert.NotEmpty(cities.Databases);
        var cityPages = await Task.WhenAll(cities.Databases.Select(database => source.GetDatabaseAsync(
            database.DatabaseId, DatabaseCityMetric.Cpu, 24, null, CancellationToken.None)));
        Assert.Contains(cityPages, page => page is { Objects.Count: > 0 });
        var live = source.GetCurrentResponse();
        Assert.NotNull(live.Snapshot);
        Assert.NotEmpty(live.Snapshot.Requests);
        Assert.Equal(SamplerRunState.Stopped, live.Collector.State);
        Assert.Equal(DataStatus.Stale, live.Snapshot.Status);
    }

    [Fact]
    public async Task New_fixture_exports_have_no_findings_payloads_or_claims()
    {
        var (manifest, payloads) = await FixtureArchiveBuilder.BuildAsync(
            new DateTimeOffset(2026, 8, 17, 23, 59, 0, TimeSpan.Zero),
            "new-fixture", false, CancellationToken.None);
        Assert.DoesNotContain("findings", manifest.IncludedSections);
        Assert.DoesNotContain(manifest.Features,
            feature => feature.Contains("findings", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(manifest.Capabilities,
            capability => capability.Contains("findings", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(manifest.Entries,
            entry => entry.Section == "findings" || entry.Name.StartsWith("findings/", StringComparison.Ordinal));
        Assert.DoesNotContain(payloads.Keys, name => name.StartsWith("findings/", StringComparison.Ordinal));
        var path = Path.Combine(_directory, "new.ssca");
        ArchivePackageWriter.Write(path, manifest, payloads, overwrite: false);
        using var source = Open(path);
        Assert.NotEmpty(source.GetCurrent().Databases);
        Assert.NotEmpty((await source.GetQueriesAsync(null, "cpu", 1, null, CancellationToken.None)).Items);
    }

    [Fact]
    public void Archive_public_surface_does_not_expose_legacy_findings_or_reference_engine()
    {
        Assert.Null(typeof(ArchiveInfo).GetProperty("ArchivedFindings"));
        Assert.DoesNotContain(typeof(ArchiveSource).Assembly.GetExportedTypes(),
            type => type.Name.Contains("Finding", StringComparison.Ordinal));
        Assert.DoesNotContain(typeof(ArchiveSource).GetFields(),
            field => field.Name.Contains("Finding", StringComparison.Ordinal));
        Assert.DoesNotContain(typeof(ArchiveSource).Assembly.GetReferencedAssemblies(),
            assembly => assembly.Name == "SqlSimCity.Findings");
        Assert.DoesNotContain(typeof(FixtureArchiveBuilder).Assembly.GetReferencedAssemblies(),
            assembly => assembly.Name == "SqlSimCity.Findings");
    }

    [Fact]
    public void Legacy_findings_metadata_is_not_published_in_archive_info()
    {
        using var source = Open(FixturePath);
        Assert.DoesNotContain("findings", source.Info.IncludedSections);
        Assert.DoesNotContain("findings-evidence-v1", source.Info.Features);
        Assert.DoesNotContain("offline-findings-reevaluation", source.Info.Capabilities);
        Assert.DoesNotContain("findings",
            JsonSerializer.Serialize(source.Info, ArchiveJson.SerializerOptions), StringComparison.OrdinalIgnoreCase);
        Assert.Contains("atlas", source.Info.IncludedSections);
        Assert.Contains("atlas-v1", source.Info.Features);
        Assert.Contains("paged-query-store", source.Info.Capabilities);
    }

    [Theory]
    [InlineData(false, false, true)]
    [InlineData(false, true, false)]
    [InlineData(false, true, true)]
    [InlineData(true, false, false)]
    [InlineData(true, false, true)]
    [InlineData(true, true, false)]
    public void Legacy_feature_snapshot_and_descriptor_must_be_present_together(
        bool feature, bool snapshot, bool descriptor)
    {
        var path = Rewrite(manifest => manifest with
        {
            Features = manifest.Features.Where(value => feature || value != "findings-evidence-v1").ToArray(),
            Entries = manifest.Entries.Where(entry =>
                (snapshot || entry.Name != SnapshotEntry) && (descriptor || entry.Name != DescriptorEntry)).ToArray(),
        });
        var error = Assert.Throws<ArchiveValidationException>(() => Validate(path));
        Assert.Contains("must be present together", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(SnapshotEntry)]
    [InlineData(DescriptorEntry)]
    public void Legacy_entries_must_be_in_findings_section(string entryName)
    {
        var path = Rewrite(manifest => manifest with
        {
            Entries = manifest.Entries.Select(entry =>
                entry.Name == entryName ? entry with { Section = "atlas" } : entry).ToArray(),
        });
        var error = Assert.Throws<ArchiveValidationException>(() => Validate(path));
        Assert.Contains("wrong section", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("mode")]
    [InlineData("engine-mismatch")]
    [InlineData("empty-engine")]
    [InlineData("long-engine")]
    [InlineData("missing-rule")]
    [InlineData("rule-version")]
    [InlineData("empty-rule")]
    [InlineData("long-rule")]
    [InlineData("empty-version")]
    [InlineData("long-version")]
    [InlineData("too-many-rules")]
    public void Legacy_descriptor_metadata_must_remain_valid(string mutation)
    {
        var path = Rewrite(entryName: DescriptorEntry, changePayload: node =>
        {
            var versions = node["ruleVersions"]!.AsObject();
            var firstRule = versions.First().Key;
            switch (mutation)
            {
                case "mode": node["mode"] = "IgnoreAllEvidence"; break;
                case "engine-mismatch": node["engineVersion"] = "different"; break;
                case "empty-engine": node["engineVersion"] = ""; break;
                case "long-engine": node["engineVersion"] = new string('v', 65); break;
                case "missing-rule": versions.Remove(firstRule); break;
                case "rule-version": versions[firstRule] = "different"; break;
                case "empty-rule": versions[""] = "1"; break;
                case "long-rule": versions[new string('r', 129)] = "1"; break;
                case "empty-version": versions[firstRule] = ""; break;
                case "long-version": versions[firstRule] = new string('v', 65); break;
                case "too-many-rules":
                    for (var i = 0; i < 129; i++)
                        versions[$"extra-{i}"] = "1";
                    break;
                default: throw new ArgumentOutOfRangeException(nameof(mutation));
            }
        });
        var error = Assert.Throws<ArchiveValidationException>(() => Validate(path));
        Assert.Contains("descriptor is inconsistent", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("engine-length")]
    [InlineData("rule-id-length")]
    [InlineData("rule-version-length")]
    [InlineData("rule-count")]
    public void Legacy_descriptor_limits_apply_even_when_versions_agree(string mutation)
    {
        using var package = ArchivePackageReader.Open(FixturePath, 1024 * 1024);
        var originalDescriptor = JsonNode.Parse(package.ReadEntry(DescriptorEntry))!;
        var firstRule = originalDescriptor["ruleVersions"]!.AsObject().First().Key;
        var longEngine = new string('e', 65);
        var longRule = new string('r', 129);
        var longVersion = new string('v', 65);
        var path = Rewrite(
            changeManifest: manifest => mutation == "rule-count" ? manifest with
            {
                Entries = manifest.Entries.Select(entry => entry.Name == DescriptorEntry
                    ? entry with { RecordCount = 129 } : entry).ToArray(),
            } : manifest,
            changePayloads: new Dictionary<string, Action<JsonObject>>(StringComparer.Ordinal)
            {
                [DescriptorEntry] = node =>
                {
                    var versions = node["ruleVersions"]!.AsObject();
                    switch (mutation)
                    {
                        case "engine-length": node["engineVersion"] = longEngine; break;
                        case "rule-id-length":
                            versions.Remove(firstRule);
                            versions[longRule] = "1";
                            break;
                        case "rule-version-length": versions[firstRule] = longVersion; break;
                        case "rule-count":
                            for (var i = versions.Count; i < 129; i++)
                                versions[$"extra-{i}"] = "1";
                            break;
                        default: throw new ArgumentOutOfRangeException(nameof(mutation));
                    }
                },
                [SnapshotEntry] = node =>
                {
                    var evaluation = node["evaluation"]!;
                    var export = node["export"]!;
                    var rules = evaluation["rules"]!.AsArray();
                    if (mutation == "engine-length")
                    {
                        evaluation["engineVersion"] = longEngine;
                        export["engineVersion"] = longEngine;
                    }
                    if (mutation == "rule-count")
                    {
                        for (var i = rules.Count; i < 129; i++)
                        {
                            var rule = rules[0]!.DeepClone();
                            rule["ruleId"] = $"extra-{i}";
                            rule["support"] = "Unsupported";
                            rule["outcome"] = "NotEvaluated";
                            rule["findingCount"] = 0;
                            rules.Add(rule);
                        }
                        evaluation["ruleCount"] = rules.Count;
                    }
                    foreach (var record in rules.Concat(export["findings"]!.AsArray()))
                    {
                        if (record!["ruleId"]!.GetValue<string>() != firstRule)
                            continue;
                        if (mutation == "rule-id-length")
                            record["ruleId"] = longRule;
                        if (mutation == "rule-version-length")
                            record["ruleVersion"] = longVersion;
                    }
                },
            });
        var error = Assert.Throws<ArchiveValidationException>(() => Validate(path));
        Assert.Contains("descriptor is inconsistent", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("evaluation-schema")]
    [InlineData("export-schema")]
    [InlineData("finding-schema")]
    [InlineData("empty-engine")]
    [InlineData("export-engine")]
    [InlineData("empty-rule-id")]
    [InlineData("empty-rule-version")]
    [InlineData("duplicate-rule")]
    [InlineData("empty-finding-rule")]
    [InlineData("empty-finding-version")]
    [InlineData("unknown-finding-rule")]
    [InlineData("finding-version")]
    public void Legacy_snapshot_metadata_must_remain_valid(string mutation)
    {
        var path = Rewrite(entryName: SnapshotEntry, changePayload: node =>
        {
            var evaluation = node["evaluation"]!;
            var export = node["export"]!;
            var rules = evaluation["rules"]!.AsArray();
            var finding = export["findings"]![0]!;
            switch (mutation)
            {
                case "evaluation-schema": evaluation["schemaVersion"] = "2.0"; break;
                case "export-schema": export["schemaVersion"] = "2.0"; break;
                case "finding-schema": finding["schemaVersion"] = "2.0"; break;
                case "empty-engine": evaluation["engineVersion"] = ""; break;
                case "export-engine": export["engineVersion"] = "different"; break;
                case "empty-rule-id": rules[0]!["ruleId"] = ""; break;
                case "empty-rule-version": rules[0]!["ruleVersion"] = ""; break;
                case "duplicate-rule": rules[1] = rules[0]!.DeepClone(); break;
                case "empty-finding-rule": finding["ruleId"] = ""; break;
                case "empty-finding-version": finding["ruleVersion"] = ""; break;
                case "unknown-finding-rule": finding["ruleId"] = "unknown"; break;
                case "finding-version": finding["ruleVersion"] = "different"; break;
                default: throw new ArgumentOutOfRangeException(nameof(mutation));
            }
        });
        var error = Assert.Throws<ArchiveValidationException>(() => Validate(path));
        Assert.Contains("Archive findings", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("unknown-field")]
    [InlineData("unknown-nested-field")]
    [InlineData("missing-required-field")]
    [InlineData("null-evaluation")]
    [InlineData("null-rules")]
    [InlineData("null-rule")]
    [InlineData("null-source")]
    [InlineData("null-finding")]
    [InlineData("null-scope")]
    [InlineData("null-evidence")]
    [InlineData("null-caveat")]
    [InlineData("invalid-enum")]
    [InlineData("numeric-enum")]
    [InlineData("invalid-evidence-kind")]
    [InlineData("invalid-impact")]
    [InlineData("invalid-freshness")]
    public void Legacy_snapshot_shape_is_strict_even_for_unpublished_data(string mutation)
    {
        var path = Rewrite(entryName: SnapshotEntry, changePayload: node =>
        {
            var finding = node["export"]!["findings"]![0]!;
            switch (mutation)
            {
                case "unknown-field": node["unknown"] = true; break;
                case "unknown-nested-field": finding["scope"]!["unknown"] = true; break;
                case "missing-required-field": finding.AsObject().Remove("title"); break;
                case "null-evaluation": node["evaluation"] = null; break;
                case "null-rules": node["evaluation"]!["rules"] = null; break;
                case "null-rule": node["evaluation"]!["rules"]![0] = null; break;
                case "null-source": node["evaluation"]!["sources"]![0] = null; break;
                case "null-finding": node["export"]!["findings"]![0] = null; break;
                case "null-scope": finding["scope"] = null; break;
                case "null-evidence": finding["evidence"]![0] = null; break;
                case "null-caveat": finding["caveats"]![0] = null; break;
                case "invalid-enum": finding["severity"] = "Catastrophic"; break;
                case "numeric-enum": finding["severity"] = 1; break;
                case "invalid-evidence-kind": finding["evidence"]![0]!["kind"] = "FutureEvidence"; break;
                case "invalid-impact": finding["impact"]!["dimension"] = "FutureImpact"; break;
                case "invalid-freshness": finding["sourceFreshness"]!["status"] = "FutureStatus"; break;
                default: throw new ArgumentOutOfRangeException(nameof(mutation));
            }
        });
        Assert.Throws<ArchiveValidationException>(() => Validate(path));
    }

    [Theory]
    [InlineData("missing-mode")]
    [InlineData("null-versions")]
    [InlineData("null-version")]
    [InlineData("unknown-field")]
    public void Legacy_descriptor_shape_is_strict(string mutation)
    {
        var path = Rewrite(entryName: DescriptorEntry, changePayload: node =>
        {
            switch (mutation)
            {
                case "missing-mode": node.Remove("mode"); break;
                case "null-versions": node["ruleVersions"] = null; break;
                case "null-version": node["ruleVersions"]!.AsObject()[node["ruleVersions"]!.AsObject().First().Key] = null; break;
                case "unknown-field": node["unknown"] = true; break;
                default: throw new ArgumentOutOfRangeException(nameof(mutation));
            }
        });
        Assert.Throws<ArchiveValidationException>(() => Validate(path));
    }

    [Theory]
    [InlineData("ruleCount")]
    [InlineData("supportedRuleCount")]
    [InlineData("firingRuleCount")]
    [InlineData("findingCount")]
    public void Legacy_evaluation_counts_match_the_payload(string field)
    {
        var path = Rewrite(entryName: SnapshotEntry, changePayload: node => node["evaluation"]![field] = -1);
        var error = Assert.Throws<ArchiveValidationException>(() => Validate(path));
        Assert.Contains("record counts", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(SnapshotEntry)]
    [InlineData(DescriptorEntry)]
    public void Legacy_entry_counts_match_the_payload(string entryName)
    {
        var path = Rewrite(manifest => manifest with
        {
            Entries = manifest.Entries.Select(entry => entry.Name == entryName
                ? entry with { RecordCount = entry.RecordCount + 1 } : entry).ToArray(),
        });
        var error = Assert.Throws<ArchiveValidationException>(() => Validate(path));
        Assert.Contains("record counts", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(499, 499)]
    [InlineData(500, 500)]
    [InlineData(501, 500)]
    [InlineData(1000, 500)]
    public async Task Legacy_capped_export_preserves_full_evaluation_and_retained_evidence(
        int totalFindings, int exportedFindings)
    {
        var path = RewriteLegacyCounts(totalFindings, exportedFindings, totalFindings, exportedFindings);
        using var package = ArchivePackageReader.Open(path, 4 * 1024 * 1024);
        Assert.Contains("findings-evidence-v1", package.Manifest.Features);
        Assert.Equal(exportedFindings, package.Manifest.Entries.Single(entry => entry.Name == SnapshotEntry).RecordCount);
        using var snapshot = JsonDocument.Parse(package.ReadEntry(SnapshotEntry));
        var evaluation = snapshot.RootElement.GetProperty("evaluation");
        Assert.Equal(totalFindings, evaluation.GetProperty("findingCount").GetInt32());
        Assert.Equal(totalFindings, evaluation.GetProperty("rules").EnumerateArray()
            .Sum(rule => rule.GetProperty("findingCount").GetInt32()));
        Assert.Equal(exportedFindings, snapshot.RootElement.GetProperty("export").GetProperty("findings").GetArrayLength());

        using var source = Open(path);
        Assert.NotEmpty(source.GetCurrent().Databases);
        var queries = await source.GetQueriesAsync(null, "cpu", 1, null, CancellationToken.None);
        Assert.Single(queries.Items);
        Assert.Equal(QueryStoreSource.ImportedArchive, queries.Items[0].Evidence.Source);
    }

    [Theory]
    [InlineData(501, 499, 501, 499)]
    [InlineData(501, 501, 501, 501)]
    [InlineData(499, 500, 499, 500)]
    [InlineData(500, 499, 500, 499)]
    [InlineData(501, 500, 500, 500)]
    [InlineData(501, 500, 501, 501)]
    public void Legacy_capped_export_rejects_inconsistent_counts(
        int totalFindings, int exportedFindings, int ruleTotal, int manifestCount)
    {
        var path = RewriteLegacyCounts(totalFindings, exportedFindings, ruleTotal, manifestCount);
        var error = Assert.Throws<ArchiveValidationException>(() => Validate(path));
        Assert.Contains("record counts", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(SnapshotEntry)]
    [InlineData(DescriptorEntry)]
    public void Legacy_payload_digests_are_not_skipped(string entryName)
    {
        var path = Rewrite(manifest => manifest with
        {
            Entries = manifest.Entries.Select(entry => entry.Name == entryName
                ? entry with { Sha256 = new string('0', 64) } : entry).ToArray(),
        });
        var error = Assert.Throws<ArchiveValidationException>(() => Validate(path));
        Assert.Contains("SHA-256", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("entry-bytes")]
    [InlineData("entry-records")]
    [InlineData("manifest-records")]
    [InlineData("manifest-entries")]
    [InlineData("manifest-bytes")]
    public void Legacy_archives_still_obey_container_bounds(string mutation)
    {
        var path = Rewrite(manifest => mutation switch
        {
            "entry-bytes" => manifest with
            {
                Entries = manifest.Entries.Select(entry => entry.Name == SnapshotEntry
                    ? entry with { ByteLength = ArchiveFormat.MaxEntryBytes + 1 } : entry).ToArray(),
            },
            "entry-records" => manifest with
            {
                Entries = manifest.Entries.Select(entry => entry.Name == SnapshotEntry
                    ? entry with { RecordCount = ArchiveFormat.MaxRecords + 1 } : entry).ToArray(),
            },
            "manifest-records" => manifest with { Limits = manifest.Limits with { MaximumRecords = 1 } },
            "manifest-entries" => manifest with { Limits = manifest.Limits with { MaximumEntries = 1 } },
            "manifest-bytes" => manifest with { Limits = manifest.Limits with { MaximumArchiveBytes = 1 } },
            _ => throw new ArgumentOutOfRangeException(nameof(mutation)),
        });
        Assert.Throws<ArchiveValidationException>(() => Validate(path));
    }

    [Fact]
    public void Legacy_feature_does_not_allow_unknown_required_features()
    {
        var path = Rewrite(manifest => manifest with
        {
            Features = manifest.Features.Append("unknown-required-v1").Order(StringComparer.Ordinal).ToArray(),
        });
        var error = Assert.Throws<ArchiveValidationException>(() => Validate(path));
        Assert.Contains("unsupported features", error.Message, StringComparison.Ordinal);
    }

    private string RewriteLegacyCounts(int totalFindings, int exportedFindings, int ruleTotal, int manifestCount) =>
        Rewrite(
            changeManifest: manifest => manifest with
            {
                Entries = manifest.Entries.Select(entry => entry.Name == SnapshotEntry
                    ? entry with { RecordCount = manifestCount } : entry).ToArray(),
            },
            entryName: SnapshotEntry,
            changePayload: node =>
            {
                var evaluation = node["evaluation"]!;
                var findings = node["export"]!["findings"]!.AsArray();
                var template = findings[0]!.DeepClone();
                var ruleId = template["ruleId"]!.GetValue<string>();
                evaluation["findingCount"] = totalFindings;
                evaluation["firingRuleCount"] = ruleTotal > 0 ? 1 : 0;
                foreach (var rule in evaluation["rules"]!.AsArray())
                {
                    var count = rule!["ruleId"]!.GetValue<string>() == ruleId ? ruleTotal : 0;
                    rule["findingCount"] = count;
                    rule["outcome"] = count > 0 ? "Firing" : "NotEvaluated";
                }
                findings.Clear();
                for (var index = 1; index <= exportedFindings; index++)
                {
                    var finding = template.DeepClone();
                    finding["findingId"] = index.ToString("x28", CultureInfo.InvariantCulture);
                    finding["scope"]!["resourceId"] = $"session:{index}";
                    finding["scope"]!["displayName"] = $"Session {index}";
                    finding["title"] = $"Session {index} is a root blocker";
                    finding["evidence"]![0]!["ref"] = $"session:{index}";
                    finding["evidence"]![0]!["label"] = $"Session {index}";
                    findings.Add(finding);
                }
            });

    private string Rewrite(
        Func<ArchiveManifest, ArchiveManifest>? changeManifest = null,
        string? entryName = null,
        Action<JsonObject>? changePayload = null,
        IReadOnlyDictionary<string, Action<JsonObject>>? changePayloads = null)
    {
        using var package = ArchivePackageReader.Open(FixturePath, 1024 * 1024);
        var payloads = package.Manifest.Entries.ToDictionary(
            entry => entry.Name, entry => package.ReadEntry(entry.Name), StringComparer.Ordinal);
        var manifest = package.Manifest;
        void RewritePayload(string name, Action<JsonObject> change)
        {
            var node = JsonNode.Parse(payloads[name])!.AsObject();
            change(node);
            var bytes = ArchiveJson.SerializeCanonical(node);
            payloads[name] = bytes;
            manifest = manifest with
            {
                Entries = manifest.Entries.Select(entry => entry.Name == name
                    ? entry with { ByteLength = bytes.Length, Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)) }
                    : entry).ToArray(),
            };
        }
        if (entryName is not null && changePayload is not null)
            RewritePayload(entryName, changePayload);
        if (changePayloads is not null)
        {
            foreach (var (name, change) in changePayloads)
                RewritePayload(name, change);
        }
        if (changeManifest is not null)
            manifest = changeManifest(manifest);
        var path = Path.Combine(_directory, "modified.ssca");
        var manifestBytes = ArchiveJson.SerializeCanonical(manifest);
        using var stream = File.Create(path);
        Span<byte> header = stackalloc byte[12];
        "SSCA\r\n\x1a\n"u8.CopyTo(header);
        BinaryPrimitives.WriteInt32BigEndian(header[8..], manifestBytes.Length);
        stream.Write(header);
        stream.Write(manifestBytes);
        foreach (var entry in manifest.Entries)
            stream.Write(payloads[entry.Name]);
        return path;
    }

    private static ArchiveSource Open(string path) => ArchiveSource.Open(
        new ArchiveSourceOptions(Path.GetDirectoryName(path)!, Path.GetFileName(path)));

    private static void Validate(string path)
    {
        using var source = Open(path);
    }

    public void Dispose() => Directory.Delete(_directory, recursive: true);
}
