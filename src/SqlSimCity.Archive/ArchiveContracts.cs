namespace SqlSimCity.Archive;

public static class ArchiveFormat
{
    public const string SchemaVersion = "1.0";
    public const int SupportedMajorVersion = 1;
    public const string SourceLabel = "ImportedArchive";
    public const int MaxManifestBytes = 4 * 1024 * 1024;
    public const int MaxEntryCount = 20_000;
    public const int MaxJsonDepth = 64;
    public const int MaxJsonStringBytes = 256 * 1024;
    public const int MaxJsonNumberBytes = 128;
    public const long MaxArchiveBytes = 1024L * 1024 * 1024;
    public const int MaxEntryBytes = 16 * 1024 * 1024;
    public const long MaxRecords = 1_000_000;
    public const int MaxNameLength = 128;
    public const int MaxManifestListItems = 128;
    public const long MaxExecutionMilliseconds = 300_000;
}

public sealed record ArchiveTarget(string OpaqueIdentity, string DisplayAlias);

public sealed record ArchiveRedactionPolicy(
    string PolicyVersion,
    bool ProtectedIdentifiersIncluded,
    bool RawSqlIncluded,
    bool RawShowplanXmlIncluded,
    IReadOnlyList<string> ExcludedFields);

public sealed record ArchiveSourceStamp(
    DateTimeOffset? ObservedAt,
    DateTimeOffset? FreshUntil,
    string? ResetEpoch,
    string RetentionResolution);

public sealed record ArchiveEntry(
    string Name,
    string Section,
    string ContentType,
    long ByteLength,
    string Sha256,
    long RecordCount,
    ArchiveSourceStamp Source);

public sealed record ArchiveLimits(
    long MaximumArchiveBytes,
    int MaximumEntries,
    long MaximumRecords,
    int MaximumNameLength,
    long MaximumExecutionMilliseconds);

public sealed record ArchiveManifest(
    string SchemaVersion,
    string ProducerVersion,
    DateTimeOffset CreatedAt,
    ArchiveTarget Target,
    IReadOnlyList<string> IncludedSections,
    IReadOnlyList<ArchiveEntry> Entries,
    ArchiveRedactionPolicy Redaction,
    IReadOnlyList<string> Features,
    IReadOnlyList<string> Capabilities,
    ArchiveLimits Limits);

public sealed record ArchiveInfo(
    string Source,
    string SchemaVersion,
    string ProducerVersion,
    DateTimeOffset CreatedAt,
    ArchiveTarget Target,
    IReadOnlyList<string> IncludedSections,
    ArchiveRedactionPolicy Redaction,
    IReadOnlyList<string> Features,
    IReadOnlyList<string> Capabilities,
    long ArchiveBytes,
    int EntryCount);

public sealed record ArchivePageSeries(
    int ChunkSize,
    long TotalCount,
    IReadOnlyList<string> Entries);

public sealed record QueryStoreArchiveIndex(
    IReadOnlyDictionary<string, string> FamilyEntries,
    IReadOnlyDictionary<string, string> PlanEntries,
    IReadOnlyDictionary<string, ArchivePageSeries> MetricPages);

public sealed record DatabaseCityArchiveIndex(
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, ArchivePageSeries>> Pages);
