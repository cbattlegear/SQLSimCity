using System.Net;
using System.Net.Http.Headers;
using Microsoft.AspNetCore.Mvc.Testing;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// The transfer layer. These assert what actually reaches the browser rather than what the
/// pipeline was configured with, because a compression provider that is registered but never
/// negotiated, or negotiated into a larger body than the alternative, looks identical in
/// configuration and is the defect that matters.
/// </summary>
public sealed class ResponseDeliveryTests : IClassFixture<WebApplicationFactory<ApiAssemblyMarker>>
{
    private readonly WebApplicationFactory<ApiAssemblyMarker> _factory;

    public ResponseDeliveryTests(WebApplicationFactory<ApiAssemblyMarker> factory) => _factory = factory;

    /// <summary>
    /// The in-memory test handler performs no automatic decompression, so the bytes observed here
    /// are the encoded bytes that would go on the wire.
    /// </summary>
    private HttpClient CreateRawClient() => _factory.CreateClient();

    [Theory]
    [InlineData("br")]
    [InlineData("gzip")]
    public async Task JsonEvidenceIsCompressedWhenTheClientOffersAnEncoding(string encoding)
    {
        using var client = CreateRawClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri("/api/v1/capabilities", UriKind.Relative));
        request.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue(encoding));

        using var response = await client.SendAsync(request);
        var body = await response.Content.ReadAsByteArrayAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(encoding, Assert.Single(response.Content.Headers.ContentEncoding));
        // A shared cache that ignored this would serve a Brotli body to a client that cannot read it.
        Assert.Contains("Accept-Encoding", response.Headers.Vary, StringComparer.OrdinalIgnoreCase);
        Assert.NotEmpty(body);
    }

    [Fact]
    public async Task AnIdentityRequestStillReceivesUncompressedEvidence()
    {
        using var client = CreateRawClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri("/api/v1/capabilities", UriKind.Relative));
        request.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("identity"));

        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Empty(response.Content.Headers.ContentEncoding);
    }

    /// <summary>
    /// Guards the level choice, not merely that some provider ran. .NET maps Brotli's `Fastest` to
    /// quality 1, which on this JSON is worse than gzip's level 1 -- so registering Brotli first at
    /// that level would negotiate the *larger* of the two bodies while looking entirely correct.
    /// </summary>
    [Fact]
    public async Task BrotliIsNotLargerThanGzipForTheSameEvidence()
    {
        using var client = CreateRawClient();

        async Task<(int Length, string Encoding)> Encoded(string encoding)
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Get, new Uri("/api/v1/capabilities", UriKind.Relative));
            request.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue(encoding));
            using var response = await client.SendAsync(request);
            var body = await response.Content.ReadAsByteArrayAsync();
            return (body.Length, response.Content.Headers.ContentEncoding.SingleOrDefault() ?? "identity");
        }

        var brotli = await Encoded("br");
        var gzip = await Encoded("gzip");

        // Without this the comparison passes vacuously when nothing is compressed at all, because
        // two identical uncompressed bodies are trivially the same size.
        Assert.Equal("br", brotli.Encoding);
        Assert.Equal("gzip", gzip.Encoding);
        Assert.True(
            brotli.Length <= gzip.Length,
            $"Brotli is preferred over gzip, so it must not be the larger body: br={brotli.Length}, gzip={gzip.Length}.");
    }

    /// <summary>
    /// Compression must not have quietly relaxed the cache directive on retained evidence.
    /// </summary>
    [Fact]
    public async Task CompressedEvidenceIsStillNeverStored()
    {
        using var client = CreateRawClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri("/api/v1/atlas", UriKind.Relative));
        request.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("br"));

        using var response = await client.SendAsync(request);

        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        Assert.Contains("object-src 'none'", response.Headers.GetValues("Content-Security-Policy").Single(),
            StringComparison.Ordinal);
    }
}
