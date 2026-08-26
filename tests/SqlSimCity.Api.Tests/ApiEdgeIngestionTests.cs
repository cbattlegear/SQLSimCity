using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Ingestion;
using SqlSimCity.Edge.Signing;

namespace SqlSimCity.Api.Tests;

public sealed class ApiEdgeIngestionTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "sqlsimcity-edge-api-" + Guid.NewGuid().ToString("N"));
    private readonly byte[] _secret = new byte[32];

    public ApiEdgeIngestionTests()
    {
        Directory.CreateDirectory(_root);
        for (var i = 0; i < _secret.Length; i++)
            _secret[i] = (byte)(i + 1);
        File.WriteAllText(Path.Combine(_root, "edge-1.key"), Convert.ToBase64String(_secret));
        File.WriteAllText(Path.Combine(_root, "catalog.json"),
            "{\"formatVersion\":1,\"connectors\":[{\"connectorId\":\"edge-1\",\"keys\":[{\"keyId\":\"k1\",\"secretFile\":\"edge-1.key\"}]}]}");
    }

    private WebApplicationFactory<ApiAssemblyMarker> EnabledFactory(
        int edgePermitPerMinute = 120,
        Action<IWebHostBuilder>? configure = null) =>
        new WebApplicationFactory<ApiAssemblyMarker>().WithWebHostBuilder(builder =>
        {
            builder.UseSetting("EdgeIngestion:Enabled", "true");
            builder.UseSetting("Acquisition:Mode", "Edge");
            builder.UseSetting("Acquisition:Edge:TargetId", "target-1");
            builder.UseSetting("EdgeIngestion:SecretCatalogFile", Path.Combine(_root, "catalog.json"));
            builder.UseSetting("EdgeIngestion:SecretsDirectory", _root);
            builder.UseSetting("EdgeIngestion:NonceJournalPath", Path.Combine(_root, "nonces.log"));
            builder.UseSetting("EdgeIngestion:RateLimitPermitPerMinute",
                edgePermitPerMinute.ToString(CultureInfo.InvariantCulture));
            // In-process test clients share one rate-limit partition; keep it out of the way here.
            builder.UseSetting("HttpSecurity:ApiPermitLimit", "10000");
            configure?.Invoke(builder);
        });

    private static ObservationBatchV1 SampleBatch()
    {
        var builder = new ObservationBatchBuilder("edge-1", "target-1", "epoch-1", "boot-1");
        var freshness = new ObservationFreshnessV1(DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, null);
        builder.AddSection(ObservationSection.Atlas, 1, DateTimeOffset.UnixEpoch, freshness, new { hello = "world" });
        return builder.Build(Guid.NewGuid().ToString("N"), DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch);
    }

    private static async Task<ObservationBatchV1> FullProjectionBatchAsync()
    {
        var now = new DateTimeOffset(2026, 8, 18, 1, 0, 0, TimeSpan.Zero);
        var freshness = new ObservationFreshnessV1(now, now, now.AddMinutes(1));
        var atlasSource = new FixtureAtlasSnapshotSource();
        var sourceAtlas = atlasSource.GetCurrent();
        var atlas = sourceAtlas with
        {
            Target = sourceAtlas.Target with { TargetId = "target-1", DisplayName = "Edge fixture target" },
        };

        var querySource = new FixtureQueryStoreHistorySource();
        var queryPage = await querySource.GetQueriesAsync(null, "cpu", 200, null, CancellationToken.None);
        var families = new List<QueryFamilyDetailV1>();
        var plans = new Dictionary<string, NormalizedShowplanV1>(StringComparer.Ordinal);
        foreach (var family in queryPage.Items)
        {
            var detail = await querySource.GetFamilyAsync(family.FamilyId, CancellationToken.None);
            Assert.NotNull(detail);
            families.Add(detail);
            foreach (var plan in detail.Plans)
            {
                if (await querySource.GetPlanAsync(plan.PlanId, CancellationToken.None) is { } normalized)
                    plans[normalized.PlanId] = normalized;
            }
        }

        var citySource = new FixtureDatabaseCitySource();
        var summaries = await citySource.GetSummariesAsync(CancellationToken.None);
        var pages = new List<DatabaseCityPageV1>();
        foreach (var database in summaries.Databases)
        foreach (var metric in Enum.GetValues<DatabaseCityMetric>())
        {
            if (await citySource.GetDatabaseAsync(
                    database.DatabaseId, metric, 50, null, CancellationToken.None) is { } page)
                pages.Add(page);
        }

        var liveSnapshot = await new FixtureLiveIncidentCollector(new FakeTimeProvider(now))
            .CollectAsync(1, CancellationToken.None);
        var live = new LiveIncidentResponseV1(
            liveSnapshot with
            {
                Target = liveSnapshot.Target with { TargetId = "target-1", DisplayName = "Edge fixture target" },
            },
            new LiveCollectorStatusV1(
                SamplerRunState.Stopped, 1, now, now, 0, null,
                "Connector captured one point-in-time sample.", 0, 0));

        var builder = new ObservationBatchBuilder("edge-1", "target-1", "epoch-1", "boot-1");
        builder.AddSection(
            ObservationSection.Atlas, 1, now, freshness,
            new AtlasObservationV1(atlas, atlasSource.GetStatus()));
        builder.AddSection(
            ObservationSection.Capabilities, 1, now, freshness,
            new CapabilitiesSnapshotV1("1", now, []));
        builder.AddSection(
            ObservationSection.QueryStore, 1, now, freshness,
            new QueryStoreObservationV1(
                await querySource.GetStatusAsync(CancellationToken.None), families, plans.Values.ToArray()));
        builder.AddSection(
            ObservationSection.DatabaseCity, 1, now, freshness,
            new DatabaseCityObservationV1(summaries, pages));
        builder.AddSection(ObservationSection.Live, 1, now, freshness, live);
        return builder.Build("full-projection", now, now);
    }

    private HttpRequestMessage SignedRequest(byte[] body, byte[]? signingSecret = null)
    {
        var signer = new HmacRequestSigner();
        var headers = signer.Sign("POST", "/api/v1/edge/ingest", "edge-1", "k1", signingSecret ?? _secret, body);
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/edge/ingest")
        {
            Content = new ByteArrayContent(body),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.TryAddWithoutValidation(EdgeSignatureHeaders.Connector, headers.ConnectorId);
        request.Headers.TryAddWithoutValidation(EdgeSignatureHeaders.KeyId, headers.KeyId);
        request.Headers.TryAddWithoutValidation(EdgeSignatureHeaders.Timestamp,
            headers.UnixTimeSeconds.ToString(CultureInfo.InvariantCulture));
        request.Headers.TryAddWithoutValidation(EdgeSignatureHeaders.Nonce, headers.Nonce);
        request.Headers.TryAddWithoutValidation(EdgeSignatureHeaders.ContentSha256, headers.BodySha256Hex);
        request.Headers.TryAddWithoutValidation(EdgeSignatureHeaders.Signature, headers.Signature);
        return request;
    }

    [Fact]
    public async Task IngestIsNotProcessedWhenDisabledByDefault()
    {
        await using var factory = new WebApplicationFactory<ApiAssemblyMarker>();
        using var client = factory.CreateClient();
        var body = EdgeJson.SerializeToUtf8Bytes(SampleBatch());

        using var request = SignedRequest(body);
        using var response = await client.SendAsync(request);

        // With ingestion disabled the route is never mapped, so a batch is never accepted (202).
        Assert.NotEqual(HttpStatusCode.Accepted, response.StatusCode);
    }

    [Theory]
    [InlineData(DataStatus.Stale, DataStatus.Available, DataStatus.Stale)]
    [InlineData(DataStatus.Available, DataStatus.Stale, DataStatus.Stale)]
    [InlineData(DataStatus.Stale, DataStatus.Disconnected, DataStatus.Disconnected)]
    [InlineData(DataStatus.PermissionDenied, DataStatus.Disconnected, DataStatus.PermissionDenied)]
    public void EdgeFreshnessNeverPromotesOrMasksSpecificEvidenceFailures(
        DataStatus payload,
        DataStatus edge,
        DataStatus expected)
    {
        Assert.Equal(expected, EdgeAcquisitionSource.EffectiveStatus(payload, edge));
    }

    [Fact]
    public async Task ValidSignedBatchIsAccepted()
    {
        await using var factory = EnabledFactory();
        using var client = factory.CreateClient();
        var body = EdgeJson.SerializeToUtf8Bytes(SampleBatch());

        using var request = SignedRequest(body);
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
    }

    [Fact]
    public async Task WrongSecretIsRejectedUnauthorized()
    {
        await using var factory = EnabledFactory();
        using var client = factory.CreateClient();
        var body = EdgeJson.SerializeToUtf8Bytes(SampleBatch());
        var attacker = new byte[32];
        Array.Fill(attacker, (byte)9);

        using var request = SignedRequest(body, attacker);
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task AuthenticatedConnectorCannotClaimAnotherConnectorIdentity()
    {
        await using var factory = EnabledFactory();
        using var client = factory.CreateClient();
        var now = DateTimeOffset.UtcNow;
        var builder = new ObservationBatchBuilder("edge-2", "target-1", "epoch-1", "boot-1");
        builder.AddSection(
            ObservationSection.Atlas,
            1,
            now,
            new ObservationFreshnessV1(now, now, now.AddMinutes(1)),
            new { forged = true });
        var body = EdgeJson.SerializeToUtf8Bytes(builder.Build("forged", now, now));

        using var request = SignedRequest(body);
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task NonJsonContentTypeIsRejected()
    {
        await using var factory = EnabledFactory();
        using var client = factory.CreateClient();
        using var content = new ByteArrayContent(Encoding.UTF8.GetBytes("not json"));
        content.Headers.ContentType = new MediaTypeHeaderValue("text/plain");

        using var response = await client.PostAsync("/api/v1/edge/ingest", content);

        Assert.Equal(HttpStatusCode.UnsupportedMediaType, response.StatusCode);
    }

    [Fact]
    public async Task StatusEndpointReportsIngestedTarget()
    {
        await using var factory = EnabledFactory();
        using var client = factory.CreateClient();
        var body = EdgeJson.SerializeToUtf8Bytes(SampleBatch());
        using (var request = SignedRequest(body))
        using (await client.SendAsync(request)) { }

        using var status = await client.GetAsync("/api/v1/edge/status");
        Assert.Equal(HttpStatusCode.OK, status.StatusCode);
        Assert.Contains("target-1", await status.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ConfiguredEdgeLimiterAppliesInAdditionToGlobalApiLimiter()
    {
        await using var factory = EnabledFactory(edgePermitPerMinute: 1);
        using var client = factory.CreateClient();
        var body = EdgeJson.SerializeToUtf8Bytes(SampleBatch());

        using (var request = SignedRequest(body))
        using (var response = await client.SendAsync(request))
            Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        using (var request = SignedRequest(body))
        using (var response = await client.SendAsync(request))
            Assert.Equal(HttpStatusCode.TooManyRequests, response.StatusCode);
    }

    [Fact]
    public async Task CompleteGenerationFeedsEveryExistingApiWithoutStartingLiveCollection()
    {
        await using var factory = EnabledFactory();
        using var client = factory.CreateClient();
        var body = EdgeJson.SerializeToUtf8Bytes(await FullProjectionBatchAsync());
        using (var request = SignedRequest(body))
        using (var response = await client.SendAsync(request))
            Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);

        var atlas = await client.GetStringAsync("/api/v1/atlas");
        var query = await client.GetStringAsync("/api/v1/query-store/queries?metric=cpu&pageSize=10");
        var city = await client.GetStringAsync("/api/v1/database-city");
        var live = await client.GetStringAsync("/api/v1/live");
        var findings = await client.GetStringAsync("/api/v1/findings?pageSize=10");

        Assert.Contains("\"mode\":\"Edge\"", atlas, StringComparison.Ordinal);
        Assert.Contains("\"targetId\":\"target-1\"", atlas, StringComparison.Ordinal);
        Assert.Contains("\"source\":\"EdgeConnector\"", query, StringComparison.Ordinal);
        Assert.Contains("\"status\":\"Disconnected\"", query, StringComparison.Ordinal);
        Assert.Contains("\"source\":\"EdgeConnector\"", city, StringComparison.Ordinal);
        Assert.Contains("\"status\":\"Disconnected\"", city, StringComparison.Ordinal);
        Assert.Contains("EdgeConnector point-in-time sample", live, StringComparison.Ordinal);
        Assert.Contains("\"state\":\"Stopped\"", live, StringComparison.Ordinal);
        Assert.Contains("\"targetId\":\"target-1\"", findings, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PartialNextGenerationDoesNotReplacePublishedProjection()
    {
        await using var factory = EnabledFactory();
        using var client = factory.CreateClient();
        var completeBody = EdgeJson.SerializeToUtf8Bytes(await FullProjectionBatchAsync());
        using (var request = SignedRequest(completeBody))
        using (var response = await client.SendAsync(request))
            Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var before = await client.GetStringAsync("/api/v1/atlas");

        var now = new DateTimeOffset(2026, 8, 18, 1, 1, 0, TimeSpan.Zero);
        var atlas = new FixtureAtlasSnapshotSource().GetCurrent();
        atlas = atlas with { Target = atlas.Target with { TargetId = "target-1" } };
        var builder = new ObservationBatchBuilder("edge-1", "target-1", "epoch-1", "boot-1");
        builder.AddSection(
            ObservationSection.Atlas,
            2,
            now,
            new ObservationFreshnessV1(now, now, now.AddMinutes(1)),
            new AtlasObservationV1(atlas, new FixtureAtlasSnapshotSource().GetStatus()));
        var partialBody = EdgeJson.SerializeToUtf8Bytes(builder.Build("partial-next", now, now));
        using (var request = SignedRequest(partialBody))
        using (var response = await client.SendAsync(request))
            Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);

        Assert.Equal(before, await client.GetStringAsync("/api/v1/atlas"));
        var source = await client.GetStringAsync("/api/v1/edge/source");
        Assert.Contains("\"sequence\":1", source, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RepeatedReadsOfAnUnchangedGenerationDoNotCopyIt()
    {
        await using var factory = EnabledFactory();
        using var client = factory.CreateClient();
        var body = EdgeJson.SerializeToUtf8Bytes(await FullProjectionBatchAsync());
        using (var request = SignedRequest(body))
        using (var response = await client.SendAsync(request))
            Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);

        var store = factory.Services.GetRequiredService<EdgeObservationStore>();
        // Prime the projection, then read every surface repeatedly. Cloning a generation deep-copies
        // every section's bytes under the store's global lock, which also blocks ingestion, so a
        // reader whose projection is already current must add no copies at all.
        await client.GetStringAsync("/api/v1/atlas");
        var copiesAfterPriming = store.PublishedGenerationCopies;

        for (var read = 0; read < 5; read++)
        {
            await client.GetStringAsync("/api/v1/atlas");
            await client.GetStringAsync("/api/v1/query-store/queries?metric=cpu&pageSize=10");
            await client.GetStringAsync("/api/v1/database-city");
            await client.GetStringAsync("/api/v1/live");
            await client.GetStringAsync("/api/v1/edge/source");
        }

        Assert.Equal(copiesAfterPriming, store.PublishedGenerationCopies);
    }

    [Fact]
    public async Task SingleSectionEndpointServesOneSectionWithoutCopyingTheGeneration()
    {
        await using var factory = EnabledFactory();
        using var client = factory.CreateClient();
        var body = EdgeJson.SerializeToUtf8Bytes(await FullProjectionBatchAsync());
        using (var request = SignedRequest(body))
        using (var response = await client.SendAsync(request))
            Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);

        var store = factory.Services.GetRequiredService<EdgeObservationStore>();
        var before = store.PublishedGenerationCopies;

        using var section = await client.GetAsync("/api/v1/edge/targets/target-1/sections/Atlas");
        Assert.Equal(HttpStatusCode.OK, section.StatusCode);
        var payload = await section.Content.ReadAsStringAsync();
        Assert.Contains("\"section\":\"Atlas\"", payload, StringComparison.Ordinal);
        Assert.Contains("\"targetId\":\"target-1\"", payload, StringComparison.Ordinal);

        // Serving one section must not clone the other four.
        Assert.Equal(before, store.PublishedGenerationCopies);

        using var missing = await client.GetAsync("/api/v1/edge/targets/other-target/sections/Atlas");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
    }

    [Fact]
    public async Task AggregateRetentionBoundRejectsAnOversizedPendingBacklog()
    {
        await using var factory = EnabledFactory(configure: builder =>
        {
            // Below MaxBatchBytes is refused as incoherent, so bound the backlog at exactly one batch.
            builder.UseSetting("EdgeIngestion:MaxBatchBytes", "4096");
            builder.UseSetting("EdgeIngestion:MaxPendingBytesPerTarget", "4096");
            builder.UseSetting("EdgeIngestion:MaxPendingBytesTotal", "4096");
        });
        using var client = factory.CreateClient();

        var accepted = 0;
        HttpStatusCode? rejection = null;
        for (var attempt = 0; attempt < 12 && rejection is null; attempt++)
        {
            var body = EdgeJson.SerializeToUtf8Bytes(PartialGroupBatch($"partial-{attempt}", attempt + 1));
            using var request = SignedRequest(body);
            using var response = await client.SendAsync(request);
            if (response.StatusCode == HttpStatusCode.Accepted)
                accepted++;
            else
                rejection = response.StatusCode;
        }

        Assert.True(accepted > 0, "No partial group was ever accepted.");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, rejection);
    }

    [Theory]
    [InlineData("EdgeIngestion:MaxPendingBytesPerTarget", "1024")]
    [InlineData("EdgeIngestion:MaxPendingBytesTotal", "1024")]
    [InlineData("EdgeIngestion:MaxPendingGroupsPerTarget", "0")]
    [InlineData("EdgeIngestion:MaxTargets", "0")]
    public async Task IncoherentRetentionBoundsFailStartupClosed(string setting, string value)
    {
        await using var factory = EnabledFactory(configure: builder => builder.UseSetting(setting, value));
        Assert.Throws<InvalidOperationException>(() => factory.CreateClient());
    }

    /// <summary>One chunk of a two-chunk group: it buffers pending bytes and never completes.</summary>
    private static ObservationBatchV1 PartialGroupBatch(string batchId, long sequence)
    {
        var now = DateTimeOffset.UnixEpoch;
        var payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(new string('p', 1400)));
        var envelope = new ObservationEnvelopeV1(
            "1.0", "edge-1", "target-1", sequence, "epoch-1", "boot-1", now,
            ObservationSection.Atlas, $"group-{sequence}", 0, 2, ObservationCompression.None,
            EdgeJson.Sha256Hex(Convert.FromBase64String(payload)),
            new ObservationFreshnessV1(now, now, null),
            payload);
        return new ObservationBatchV1(
            "1.0", "edge-1", batchId,
            ObservationBatchBuilder.DeriveIdempotencyKey("edge-1", [envelope]),
            now, now, [envelope]);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root))
                Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // The nonce journal may still be held briefly by a disposing host; cleanup is best-effort.
        }
    }
}
