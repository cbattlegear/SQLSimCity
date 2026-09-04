using System.Text.Json;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Archive;

public sealed partial class ArchiveSource
{
    private const string LegacyFindingsFeature = "findings-evidence-v1";
    private const string LegacyFindingsSnapshotEntry = "findings/snapshot.json";
    private const string LegacyFindingsDescriptorEntry = "findings/descriptor.json";
    private const int LegacyMaxExportFindings = 500;

    private static readonly JsonSerializerOptions LegacyFindingsJsonOptions = new(ArchiveJson.SerializerOptions)
    {
        RespectNullableAnnotations = true,
        RespectRequiredConstructorParameters = true,
    };

    // Format-1 compatibility is validation-only: no legacy payload is published or reevaluated.
    private void ValidateLegacyFindings()
    {
        var hasSnapshot = _package.Manifest.Entries.Any(entry => entry.Name == LegacyFindingsSnapshotEntry);
        var hasDescriptor = _package.Manifest.Entries.Any(entry => entry.Name == LegacyFindingsDescriptorEntry);
        var declaresFeature = _package.Manifest.Features.Contains(LegacyFindingsFeature, StringComparer.Ordinal);
        if (hasSnapshot != hasDescriptor || declaresFeature != hasSnapshot)
            throw new ArchiveValidationException(
                "Archive findings feature, snapshot, and descriptor must be present together.");
        if (!hasSnapshot)
            return;

        var snapshotEntry = RequireSection(LegacyFindingsSnapshotEntry, "findings");
        var descriptorEntry = RequireSection(LegacyFindingsDescriptorEntry, "findings");
        var snapshot = ReadLegacyFindings<LegacySnapshot>(LegacyFindingsSnapshotEntry);
        var descriptor = ReadLegacyFindings<LegacyDescriptor>(LegacyFindingsDescriptorEntry);
        var evaluation = snapshot.Evaluation;
        var export = snapshot.Export;
        if (evaluation.Rules.Any(rule => rule is null) ||
            evaluation.Sources.Any(source => source is null) ||
            export.Findings.Any(finding => finding is null))
            throw new ArchiveValidationException("Archive findings collections contain null records.");

        if (evaluation.SchemaVersion != "1.0" ||
            export.SchemaVersion != "1.0" ||
            string.IsNullOrWhiteSpace(evaluation.EngineVersion) ||
            evaluation.Rules.Select(rule => rule.RuleId).Distinct(StringComparer.Ordinal).Count() != evaluation.Rules.Count ||
            evaluation.Rules.Any(rule =>
                string.IsNullOrWhiteSpace(rule.RuleId) || string.IsNullOrWhiteSpace(rule.RuleVersion)) ||
            export.EngineVersion != evaluation.EngineVersion ||
            export.Findings.Any(finding =>
                finding.SchemaVersion != "1.0" ||
                string.IsNullOrWhiteSpace(finding.RuleId) ||
                string.IsNullOrWhiteSpace(finding.RuleVersion)))
            throw new ArchiveValidationException("Archive findings engine or rule version metadata is invalid.");

        if (descriptor.Mode != "ReevaluateImportedEvidence" ||
            string.IsNullOrWhiteSpace(descriptor.EngineVersion) ||
            descriptor.EngineVersion.Length > 64 ||
            descriptor.RuleVersions.Count > ArchiveFormat.MaxManifestListItems ||
            descriptor.RuleVersions.Any(pair =>
                string.IsNullOrWhiteSpace(pair.Key) || pair.Key.Length > 128 ||
                string.IsNullOrWhiteSpace(pair.Value) || pair.Value.Length > 64) ||
            evaluation.EngineVersion != descriptor.EngineVersion ||
            evaluation.Rules.Count != descriptor.RuleVersions.Count ||
            evaluation.Rules.Any(rule =>
                !descriptor.RuleVersions.TryGetValue(rule.RuleId, out var version) || version != rule.RuleVersion) ||
            export.Findings.Any(finding =>
                !descriptor.RuleVersions.TryGetValue(finding.RuleId, out var version) || version != finding.RuleVersion))
            throw new ArchiveValidationException("Archive findings descriptor is inconsistent.");

        // The format-1 exporter kept full evaluation totals but capped the redacted list at 500.
        if (evaluation.RuleCount != evaluation.Rules.Count ||
            evaluation.SupportedRuleCount != evaluation.Rules.Count(rule => rule.Support == LegacyRuleSupport.Supported) ||
            evaluation.FiringRuleCount != evaluation.Rules.Count(rule => rule.Outcome == LegacyFindingStatus.Firing) ||
            evaluation.Rules.Any(rule => rule.FindingCount < 0) ||
            evaluation.Rules.Sum(rule => (long)rule.FindingCount) != evaluation.FindingCount ||
            export.Findings.Count != Math.Min(evaluation.FindingCount, LegacyMaxExportFindings) ||
            export.RedactedFieldCount < 0 ||
            snapshotEntry.RecordCount != export.Findings.Count ||
            descriptorEntry.RecordCount != descriptor.RuleVersions.Count)
            throw new ArchiveValidationException("Archive findings record counts are inconsistent.");

        foreach (var finding in export.Findings)
        {
            if (finding.Evidence.Any(item => item is null) ||
                finding.Caveats.Any(item => item is null) ||
                finding.AlternateExplanations.Any(item => item is null) ||
                finding.RecommendedNextChecks.Any(item => item is null))
                throw new ArchiveValidationException("Archive findings collections contain null values.");
        }
    }

    private T ReadLegacyFindings<T>(string entry)
    {
        var bytes = _package.ReadEntry(entry);
        ArchiveJson.Validate(bytes);
        try
        {
            return JsonSerializer.Deserialize<T>(bytes, LegacyFindingsJsonOptions)
                ?? throw new ArchiveValidationException($"Archive legacy findings payload '{entry}' was null.");
        }
        catch (JsonException exception)
        {
            throw new ArchiveValidationException($"Archive legacy findings payload '{entry}' is invalid: {exception.Message}");
        }
    }

    private sealed record LegacySnapshot(LegacyEvaluation Evaluation, LegacyExport Export);

    private sealed record LegacyDescriptor(
        string Mode,
        string EngineVersion,
        IReadOnlyDictionary<string, string> RuleVersions);

    private sealed record LegacyEvaluation(
        string SchemaVersion,
        DateTimeOffset GeneratedAt,
        string EngineVersion,
        int RuleCount,
        int SupportedRuleCount,
        int FiringRuleCount,
        int FindingCount,
        IReadOnlyList<LegacyRule> Rules,
        IReadOnlyList<LegacyFreshness> Sources,
        string Reason);

    private sealed record LegacyRule(
        string RuleId,
        string RuleVersion,
        string Title,
        string Description,
        LegacyRuleSupport Support,
        LegacyFindingStatus Outcome,
        int FindingCount,
        string Reason);

    private sealed record LegacyExport(
        string SchemaVersion,
        DateTimeOffset GeneratedAt,
        string EngineVersion,
        string RedactionNote,
        int RedactedFieldCount,
        IReadOnlyList<LegacyFinding> Findings);

    private sealed record LegacyFinding(
        string SchemaVersion,
        string FindingId,
        string RuleId,
        string RuleVersion,
        string Title,
        LegacyScope Scope,
        LegacyWindow ObservedWindow,
        LegacyFindingStatus Status,
        LegacySeverity Severity,
        LegacyImpact Impact,
        LegacyConfidence Confidence,
        IReadOnlyList<LegacyEvidence> Evidence,
        IReadOnlyList<string> Caveats,
        IReadOnlyList<string> AlternateExplanations,
        IReadOnlyList<string> RecommendedNextChecks,
        string ReadOnlyRecommendation,
        LegacyFreshness SourceFreshness);

    private sealed record LegacyScope(
        string TargetId,
        string? DatabaseId,
        string? QueryFamilyId,
        string? PlanId,
        string DisplayName)
    {
        public string? ResourceId { get; init; }
    }

    private sealed record LegacyWindow(DateTimeOffset? Start, DateTimeOffset? End, string Kind, string Caveat);

    private sealed record LegacyImpact(LegacyImpactDimension Dimension, string? Magnitude, string Unit, string Basis);

    private sealed record LegacyEvidence(LegacyEvidenceKind Kind, string Ref, string Label, string Observation);

    private sealed record LegacyFreshness(
        EvidenceSource Source,
        DataStatus Status,
        DateTimeOffset? ObservedAt,
        DateTimeOffset? FreshUntil,
        string Reason);

    private enum LegacyFindingStatus { Firing, NotEvaluated, InsufficientEvidence }
    private enum LegacySeverity { Informational, Advisory, Notable, Serious }
    private enum LegacyConfidence { Low, Medium, High }
    private enum LegacyRuleSupport { Supported, Unsupported }

    private enum LegacyImpactDimension
    {
        None,
        DurationMicroseconds,
        CpuMicroseconds,
        LogicalReads8KiBPages,
        WaitMilliseconds,
        BlockedSessions,
        MemoryGrantKb,
        AbortedExecutionShare,
        PlanCount,
        LogSpacePercent,
        IoStallMilliseconds,
    }

    private enum LegacyEvidenceKind
    {
        QueryStoreFamily,
        QueryStorePlan,
        QueryStoreRuntimeBucket,
        QueryStoreStatus,
        LiveRequest,
        LiveBlockingNode,
        LiveMemoryGrant,
        LiveLogSpace,
        LiveFileIo,
        AtlasDatabase,
        Capability,
    }
}
