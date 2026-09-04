using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace SqlSimCity.Api.Tests;

public sealed class RetiredFindingsEndpointTests : IClassFixture<WebApplicationFactory<ApiAssemblyMarker>>
{
    private readonly HttpClient _client;

    public RetiredFindingsEndpointTests(WebApplicationFactory<ApiAssemblyMarker> factory)
    {
        _client = factory.CreateClient();
    }

    [Theory]
    [InlineData("/api/v1/findings")]
    [InlineData("/api/v1/findings/")]
    [InlineData("/api/v1/findings/status")]
    [InlineData("/api/v1/findings/export?preview=true")]
    [InlineData("/api/v1/findings/rules/query-store-health")]
    [InlineData("/api/v1/findings/old-finding-id")]
    [InlineData("/api/v1/findings/nested/unknown.json")]
    [InlineData("/api/v1/findings?pageToken=malformed&severity=anything")]
    public async Task RetiredRoutesReturnOnlyJsonTombstoneNeverSpaOrEvidence(string path)
    {
        using var response = await _client.GetAsync(new Uri(path, UriKind.Relative));
        Assert.Equal(HttpStatusCode.Gone, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var property = Assert.Single(document.RootElement.EnumerateObject());
        Assert.Equal("error", property.Name);
        Assert.Equal("Findings has been removed. Use the retained evidence APIs.", property.Value.GetString());
    }

    [Theory]
    [InlineData("POST")]
    [InlineData("PUT")]
    [InlineData("DELETE")]
    public async Task RetiredRouteCannotBeReactivatedByAnotherMethod(string method)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), "/api/v1/findings/export");
        using var response = await _client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Gone, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public void ApiAssemblyDoesNotReferenceTheRetiredEngine()
    {
        Assert.DoesNotContain(typeof(ApiAssemblyMarker).Assembly.GetReferencedAssemblies(),
            assembly => assembly.Name == "SqlSimCity.Findings");
    }

    [Fact]
    public async Task TombstoneDoesNotCaptureOtherApiFamilies()
    {
        using var response = await _client.GetAsync(new Uri("/api/v1/query-store/status", UriKind.Relative));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
