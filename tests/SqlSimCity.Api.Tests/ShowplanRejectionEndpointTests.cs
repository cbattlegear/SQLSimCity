using System.Net;
using System.Text.Json;
using System.Xml;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api.Tests;

public sealed class ShowplanRejectionEndpointTests
{
    [Theory]
    [InlineData("/api/v1/query-store/plans/plan-a", "This Showplan could not be normalized.")]
    [InlineData("/api/v1/query-store/plans/compare?leftPlanId=plan-a&rightPlanId=plan-b",
        "One of these Showplans could not be normalized, so no comparison is claimed.")]
    public async Task BoundedParserRejectionIsAnExplicitJson422(string path, string prefix)
    {
        await using var factory = new WebApplicationFactory<ApiAssemblyMarker>().WithWebHostBuilder(
            builder => builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<IQueryStoreHistorySource>();
                services.AddSingleton<IQueryStoreHistorySource, RejectedShowplans>();
            }));
        using var client = factory.CreateClient();
        using var response = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal($"{prefix} {RejectedShowplans.Reason}", document.RootElement.GetProperty("error").GetString());
    }

    private sealed class RejectedShowplans : IQueryStoreHistorySource
    {
        public const string Reason = "Showplan XML exceeds the maximum allowed node count.";

        public Task<NormalizedShowplanV1?> GetPlanAsync(string planId, CancellationToken cancellationToken) =>
            throw new XmlException(Reason);
        public Task<PlanComparisonV1?> ComparePlansAsync(
            string leftPlanId, string rightPlanId, CancellationToken cancellationToken) =>
            throw new XmlException(Reason);
        public Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(
            string? databaseId, string metric, int pageSize, string? pageToken, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("The endpoint must request a plan directly.");
        public Task<QueryFamilyDetailV1?> GetFamilyAsync(string familyId, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("The endpoint must request a plan directly.");
        public Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken) =>
            throw new InvalidOperationException("The endpoint must request a plan directly.");
    }
}
