using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Contracts.Tests;

public sealed class DatabaseCityNamespaceTests
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    [Theory]
    [InlineData("sales")]
    [InlineData(null)]
    public void ExplicitNamespaceRoundTripsIncludingNull(string? databaseId)
    {
        var page = Page() with { QueryStoreDatabaseId = databaseId };
        var json = JsonSerializer.SerializeToNode(page, Options)!.AsObject();
        Assert.True(json.ContainsKey("queryStoreDatabaseId"));
        Assert.Equal(databaseId, json["queryStoreDatabaseId"]?.GetValue<string>());
        var restored = json.Deserialize<DatabaseCityPageV1>(Options)!;
        Assert.Equal(databaseId, restored.QueryStoreDatabaseId);
        Assert.True(restored.HasQueryStoreDatabaseId);
        Assert.False(json.ContainsKey("hasQueryStoreDatabaseId"));
        Assert.Equal("endpoint/database/sales", restored.DatabaseId);
    }

    [Fact]
    public void OmittedLegacyNamespacePermitsOnlyExactOwnerIdentity()
    {
        var json = JsonSerializer.SerializeToNode(Page(), Options)!.AsObject();
        Assert.True(json.Remove("queryStoreDatabaseId"));
        var restored = json.Deserialize<DatabaseCityPageV1>(Options)!;
        Assert.False(restored.HasQueryStoreDatabaseId);
        Assert.Equal(restored.DatabaseId, restored.QueryStoreDatabaseId);
        Assert.NotEqual("sales", restored.QueryStoreDatabaseId);
    }

    private static DatabaseCityPageV1 Page()
    {
        var evidence = new EvidenceV1(EvidenceSource.Fixture, DataStatus.Available, null, null, "fixture");
        return new DatabaseCityPageV1(
            "1.0", "endpoint/database/sales", "Sales", DatabaseCityMetric.Cpu, 10, null, "0",
            [], [], [], new DatabaseCityWorkloadAggregateV1(null, null, null, null, null, null, evidence),
            [], evidence);
    }
}
