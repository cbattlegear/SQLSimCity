using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain.DatabaseCity;

namespace SqlSimCity.Api.Tests;

public sealed class LegacyCityNamespaceResolverTests
{
    private const string Owner = "target/database/sales";
    private static readonly EvidenceV1 Evidence = new(EvidenceSource.ImportedArchive, DataStatus.Stale, null, null, "capture");
    private static readonly QueryStoreEvidenceV1 QueryEvidence =
        new(QueryStoreSource.ImportedArchive, DataStatus.Stale, null, null, "capture", "capture");

    [Theory]
    [InlineData("unmatched-family")]
    [InlineData("conflicting-namespaces")]
    [InlineData("conflicting-family-identity")]
    [InlineData("competing-owner")]
    [InlineData("foreign-city")]
    [InlineData("duplicate-catalog-owner")]
    [InlineData("explicit-null")]
    public void CannotInferFromUnmatchedOrAmbiguousCapture(string scenario)
    {
        QueryFamilySummaryV1[] families = [Family("captured", "sales")];
        DatabaseCityPageV1[] pages = [Page(Owner, "captured")];
        string[] catalog = [Owner];
        switch (scenario)
        {
            case "unmatched-family":
                pages = [Page(Owner, "captured-lookalike")];
                break;
            case "conflicting-namespaces":
                families = [Family("captured", "sales"), Family("another", "other-sales")];
                pages = [Page(Owner, "captured"), Page(Owner, "another")];
                break;
            case "conflicting-family-identity":
                families = [Family("captured", "sales"), Family("captured", "other-sales")];
                break;
            case "competing-owner":
                pages = [Page(Owner, "captured"), Page("foreign/database/sales", "captured")];
                break;
            case "foreign-city":
                pages = [Page("foreign/database/sales", "captured")];
                break;
            case "duplicate-catalog-owner":
                catalog = [Owner, Owner];
                break;
            case "explicit-null":
                pages = [pages[0] with { QueryStoreDatabaseId = null }];
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(scenario));
        }
        var resolver = new DatabaseCityNamespaceResolver(families, catalog);
        foreach (var page in pages)
            resolver.Observe(page);
        Assert.Empty(resolver.GetMappings());
    }

    private static QueryFamilySummaryV1 Family(string id, string database) => new(
        id, database, "hash", null,
        new QueryTextDescriptorV1(QueryTextAvailability.Restricted, null, null, "capture"),
        [], "1", "1", "1", "1", "1", DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, QueryEvidence);

    private static DatabaseCityPageV1 Page(string owner, string family) => new(
        "1.0", owner, "Sales", DatabaseCityMetric.Cpu, 1, null, "0", [], [],
        [new DatabaseCityQueryFamilyV1(family, "hash", "1", "1", "1", "1", "1",
            new Dictionary<string, string>(), [], QueryAttributionConfidence.Unknown, "capture", Evidence)],
        new DatabaseCityWorkloadAggregateV1(null, null, null, null, null, null, Evidence), [], Evidence);
}
