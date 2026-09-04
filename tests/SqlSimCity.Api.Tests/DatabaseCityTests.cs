using System.Net;
using System.Net.Http.Json;
using System.Globalization;
using System.Numerics;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using SqlSimCity.Api;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api.Tests;

public sealed class DatabaseCityTests : IClassFixture<WebApplicationFactory<ApiAssemblyMarker>>
{
    private readonly HttpClient _client;

    public DatabaseCityTests(WebApplicationFactory<ApiAssemblyMarker> factory)
    {
        _client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
    }

    [Fact]
    public async Task SummaryAndDetailEndpointsAreVersionedBoundedAndExact()
    {
        using var summaries = await _client.GetAsync("/api/v1/database-city");
        using var detail = await _client.GetAsync(
            "/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fsales?metric=cpu&pageSize=2");
        using var document = JsonDocument.Parse(await detail.Content.ReadAsStringAsync());

        Assert.Equal(HttpStatusCode.OK, summaries.StatusCode);
        Assert.Equal(HttpStatusCode.OK, detail.StatusCode);
        Assert.Equal("1.0", document.RootElement.GetProperty("schemaVersion").GetString());
        Assert.Equal(2, document.RootElement.GetProperty("objects").GetArrayLength());
        Assert.True(document.RootElement.GetProperty("topQueryFamilies").GetArrayLength() <= 12);
        Assert.Equal(JsonValueKind.String,
            document.RootElement.GetProperty("objects")[0].GetProperty("reservedBytes").ValueKind);
        Assert.Equal(JsonValueKind.String,
            document.RootElement.GetProperty("otherWorkload").GetProperty("totalCpuMicroseconds").ValueKind);
        Assert.Equal("no-store", detail.Headers.CacheControl?.ToString());
    }

    [Fact]
    public async Task FixtureCityPublishesAQueryableNamespaceWithoutRelabelingItsOwner()
    {
        const string owner = "fixture-target-primary/database/sales";
        string? pageToken = null;
        do
        {
            var cursor = pageToken is null ? string.Empty : $"&pageToken={Uri.EscapeDataString(pageToken)}";
            using var response = await _client.GetAsync(
                $"/api/v1/database-city/{Uri.EscapeDataString(owner)}?pageSize=2{cursor}");
            response.EnsureSuccessStatusCode();
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            Assert.Equal(owner, document.RootElement.GetProperty("databaseId").GetString());
            Assert.Equal("sales", document.RootElement.GetProperty("queryStoreDatabaseId").GetString());
            pageToken = document.RootElement.GetProperty("nextPageToken").GetString();
        } while (pageToken is not null);

        using var queries = JsonDocument.Parse(await _client.GetStringAsync(
            "/api/v1/query-store/queries?databaseId=sales&metric=cpu&pageSize=10"));
        var families = queries.RootElement.GetProperty("items").EnumerateArray().ToArray();
        Assert.NotEmpty(families);
        Assert.All(families, family => Assert.Equal("sales", family.GetProperty("databaseId").GetString()));
    }

    [Theory]
    [InlineData("ledger")]
    [InlineData("master")]
    public async Task UnprovenFixtureNamespaceIsExplicitNull(string database)
    {
        using var document = JsonDocument.Parse(await _client.GetStringAsync(
            $"/api/v1/database-city/fixture-target-primary%2Fdatabase%2F{database}?pageSize=10"));
        Assert.Equal(JsonValueKind.Null, document.RootElement.GetProperty("queryStoreDatabaseId").ValueKind);
    }

    [Theory]
    [InlineData("/api/v1/database-city/not%20valid?metric=cpu&pageSize=10")]
    [InlineData("/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fsales?metric=decoration&pageSize=10")]
    [InlineData("/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fsales?metric=cpu&pageSize=0")]
    [InlineData("/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fsales?metric=cpu&pageSize=51")]
    [InlineData("/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fsales?metric=cpu&pageToken=not-base64")]
    public async Task DetailEndpointRejectsInvalidInputs(string path)
    {
        using var response = await _client.GetAsync(path);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task EscapedCanonicalDatabaseIdIsValidEvenWhenItDoesNotExist()
    {
        using var response = await _client.GetAsync(
            "/api/v1/database-city/fixture-target-primary%2Fdatabase%2FSales%2520West?metric=cpu&pageSize=10");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(
            "target/database/Sales%2FWest",
            DatabaseCityEndpoints.NormalizeDatabaseIdForRoute(
                "target%2Fdatabase%2FSales%2FWest"));
        Assert.True(DatabaseCityEndpoints.IsValidDatabaseId(
            $"target/database/{string.Concat(Enumerable.Repeat("%E8%A1%97", 128))}..~"));
    }

    [Fact]
    public async Task UnavailableFixtureDatabaseDoesNotReportMeasuredZero()
    {
        using var response = await _client.GetAsync(
            "/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fledger?metric=cpu&pageSize=10");
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(JsonValueKind.Null, document.RootElement.GetProperty("totalObjects").ValueKind);
        Assert.Equal(JsonValueKind.Null,
            document.RootElement.GetProperty("otherWorkload").GetProperty("familyCount").ValueKind);
        Assert.Equal(JsonValueKind.Null,
            document.RootElement.GetProperty("otherWorkload").GetProperty("totalCpuMicroseconds").ValueKind);
    }

    [Fact]
    public async Task KnownEmptyFixtureDatabasePreservesMeasuredZero()
    {
        using var response = await _client.GetAsync(
            "/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fmaster?metric=cpu&pageSize=10");
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("0", document.RootElement.GetProperty("totalObjects").GetString());
        Assert.Equal("0", document.RootElement.GetProperty("otherWorkload").GetProperty("familyCount").GetString());
        Assert.Equal("0",
            document.RootElement.GetProperty("otherWorkload").GetProperty("totalCpuMicroseconds").GetString());
    }

    [Fact]
    public async Task JoinOnlyFixtureObjectReportsSharedTotalsWithoutInventingItsOwn()
    {
        // The shape issue #40 reported: a child table every ranked plan reaches through a join. It
        // must reach the wire with null attributed totals -- no number was measured for it alone --
        // while the query-level totals it participates in are carried whole. Serving it any other way
        // either invents a per-object figure or hides the workload entirely.
        using var response = await _client.GetAsync(
            "/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fsales?metric=cpu&pageSize=10");
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var detail = document.RootElement.GetProperty("objects").EnumerateArray()
            .Single(o => o.GetProperty("name").GetString() == "OrderDetail");
        var exposure = detail.GetProperty("attributedExposure");
        var shared = exposure.GetProperty("shared");

        Assert.Equal(JsonValueKind.Null, exposure.GetProperty("totalCpuMicroseconds").ValueKind);
        Assert.Equal("Unknown", exposure.GetProperty("confidence").GetString());
        Assert.Equal("10000030", shared.GetProperty("totalCpuMicroseconds").GetString());
        Assert.Equal("1", shared.GetProperty("familyCount").GetString());
        Assert.Contains("must not be summed", shared.GetProperty("rationale").GetString());

        // The same query totals appear whole on every object that query named, so the shared figure
        // repeats rather than dividing. A reader who adds them up is double-counting, which is
        // exactly what the rationale warns against.
        var customer = document.RootElement.GetProperty("objects").EnumerateArray()
            .Single(o => o.GetProperty("name").GetString() == "Customer");
        Assert.Equal("10000030",
            customer.GetProperty("attributedExposure").GetProperty("shared")
                .GetProperty("totalCpuMicroseconds").GetString());
        // Customer keeps its own measured attribution alongside the shared figure; one never
        // overwrites the other.
        Assert.Equal("14089536",
            customer.GetProperty("attributedExposure").GetProperty("totalCpuMicroseconds").GetString());
    }

    [Fact]
    public void ProjectorIsSourceOrderInvariantAndPreservesUnknownAndZero()
    {
        var schema = new DatabaseCitySchemaEvidence("schema:dbo", "dbo");
        var objects = new[]
        {
            new DatabaseCityObjectEvidence("object:b", "schema:dbo", "B", DatabaseObjectKind.Table, "0", "0", [], []),
            new DatabaseCityObjectEvidence("object:a", "schema:dbo", "A", DatabaseObjectKind.IndexedView, null, null, [], []),
        };

        var forward = DatabaseCityProjector.ProjectObjects([schema], objects);
        var reverse = DatabaseCityProjector.ProjectObjects([schema], objects.Reverse());

        Assert.Equal(forward, reverse);
        Assert.Equal(MeasurementStatus.Unknown, forward[0].SizeStatus);
        Assert.Null(forward[0].ReservedBytes);
        Assert.Equal(MeasurementStatus.Known, forward[1].SizeStatus);
        Assert.Equal("0", forward[1].ReservedBytes);
    }

    [Fact]
    public void ProjectorConvertsEightKibPagesWithoutPrecisionLoss()
    {
        const string pages = "9007199254740993";
        var projected = DatabaseCityProjector.ProjectObjects(
            [new DatabaseCitySchemaEvidence("schema:dbo", "dbo")],
            [new DatabaseCityObjectEvidence(
                "object:large", "schema:dbo", "Large", DatabaseObjectKind.Table, pages, pages, [], [])]);

        Assert.Equal((BigInteger.Parse(pages, CultureInfo.InvariantCulture) * 8192)
            .ToString(CultureInfo.InvariantCulture), projected[0].ReservedBytes);
        Assert.Equal((BigInteger.Parse(pages, CultureInfo.InvariantCulture) * 8192)
            .ToString(CultureInfo.InvariantCulture), projected[0].UsedBytes);
    }

    [Fact]
    public void ProjectorDoesNotOverlapLargeNeighborhoods()
    {
        var objects = Enumerable.Range(1, 800)
            .Select(index => new DatabaseCityObjectEvidence(
                $"object:{index:D4}", "schema:dbo", $"Object{index:D4}",
                DatabaseObjectKind.Table, "1", "1", [], [])
            {
                LayoutOrdinal = index,
            });

        var projected = DatabaseCityProjector.ProjectObjects(
            [new DatabaseCitySchemaEvidence("schema:dbo", "dbo", 1)], objects);

        Assert.Equal(projected.Count, projected.Select(item => (item.Layout.X, item.Layout.Z)).Distinct().Count());
    }

    [Fact]
    public void WorkloadProjectionBoundsOneHundredThousandFamiliesAndAggregatesOther()
    {
        var families = Enumerable.Range(1, 100_000)
            .Select(index => new DatabaseCityQueryEvidence(
                $"family:{index:D6}", $"hash:{index:D6}",
                index.ToString(CultureInfo.InvariantCulture), index.ToString(CultureInfo.InvariantCulture),
                index.ToString(CultureInfo.InvariantCulture), index.ToString(CultureInfo.InvariantCulture),
                index.ToString(CultureInfo.InvariantCulture), [], QueryAttributionConfidence.Confirmed,
                "A normalized plan names one object."));

        var projected = DatabaseCityProjector.ProjectWorkload(families, DatabaseCityMetric.Cpu, 12);
        var expectedOtherCpu = Enumerable.Range(1, 100_000 - 12)
            .Select(index => new BigInteger(index))
            .Aggregate(BigInteger.Zero, (sum, value) => sum + value);

        Assert.Equal(12, projected.Top.Count);
        Assert.Equal("99988", projected.Other.FamilyCount);
        Assert.Equal(expectedOtherCpu.ToString(CultureInfo.InvariantCulture), projected.Other.TotalCpuMicroseconds);
    }

    [Fact]
    public async Task FixtureSourceSeparatesDirectAndAttributedEvidenceAndHonorsCancellation()
    {
        var source = new FixtureDatabaseCitySource();
        var page = await source.GetDatabaseAsync(
            "fixture-target-primary/database/sales", DatabaseCityMetric.Cpu, 20, null, CancellationToken.None);
        var customer = page!.Objects.Single(item => item.Name == "Customer");
        var expectedCustomerCpu = page.TopQueryFamilies
            .Where(family => family.ObjectIds.Count == 1 && family.ObjectIds[0] == customer.ObjectId)
            .Aggregate(BigInteger.Zero, (sum, family) =>
                sum + BigInteger.Parse(family.TotalCpuMicroseconds, CultureInfo.InvariantCulture));
        var linkedCityFamily = page.TopQueryFamilies.Single(family => family.FamilyId == "qf:sales-orders");
        var linkedQueryStoreFamily = await new FixtureQueryStoreHistorySource()
            .GetFamilyAsync("qf:sales-orders", CancellationToken.None);

        Assert.Equal(EvidenceSource.LiveDmvCumulative, customer.DirectActivity.Evidence.Source);
        Assert.Equal(EvidenceSource.QueryStoreAggregate, customer.AttributedExposure.Evidence.Source);
        Assert.Equal(expectedCustomerCpu.ToString(CultureInfo.InvariantCulture),
            customer.AttributedExposure.TotalCpuMicroseconds);
        Assert.NotNull(linkedQueryStoreFamily);
        Assert.Equal(linkedQueryStoreFamily.Family.QueryHash, linkedCityFamily.QueryHash);
        Assert.Equal(linkedQueryStoreFamily.Family.ExecutionCount, linkedCityFamily.ExecutionCount);
        Assert.Equal(linkedQueryStoreFamily.Family.TotalCpuMicroseconds, linkedCityFamily.TotalCpuMicroseconds);
        Assert.Equal(linkedQueryStoreFamily.Family.TotalLogicalReads8KiBPages,
            linkedCityFamily.TotalLogicalReads8KiBPages);
        Assert.Contains(customer.Indexes, index => index.DirectActivity.TotalOperations != "0");
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => source.GetDatabaseAsync(
            page.DatabaseId, DatabaseCityMetric.Cpu, 20, null, new CancellationToken(canceled: true)));
    }

    [Fact]
    public async Task FixtureSourceExposesWaitCategoriesThatReconcileWithTotalWait()
    {
        var source = new FixtureDatabaseCitySource();
        var page = await source.GetDatabaseAsync(
            "fixture-target-primary/database/sales", DatabaseCityMetric.Cpu, 20, null, CancellationToken.None);

        var measured = page!.TopQueryFamilies
            .Where(family => family.WaitMillisecondsByCategory.Count > 0)
            .ToList();

        Assert.NotEmpty(measured);
        foreach (var family in measured)
        {
            // A breakdown that does not reconcile with the total would claim waits the engine never
            // reported, so the fixture must never ship one.
            var breakdown = family.WaitMillisecondsByCategory.Values.Aggregate(
                BigInteger.Zero, (sum, value) => sum + BigInteger.Parse(value, CultureInfo.InvariantCulture));
            Assert.Equal(family.TotalWaitMilliseconds, breakdown.ToString(CultureInfo.InvariantCulture));
        }

        // Families without the breakdown are kept, not dropped: absent categories are not zero waits.
        Assert.Contains(page.TopQueryFamilies, family =>
            family.WaitMillisecondsByCategory.Count == 0 && family.TotalWaitMilliseconds != "0");
    }

    /// <summary>
    /// The vehicle ladder picks a class from <c>PlanDataVolume</c>, so a band with no fixture family
    /// in it is a vehicle nobody can see without a live server -- and the gap is silent, because
    /// every band still renders something. The fixture set had exactly that hole (nothing between
    /// 64 KiB and 8 MiB) until this pinned it.
    /// </summary>
    [Fact]
    public async Task FixtureSourcePlanDataVolumesSpanEveryVehicleBandSoNoClassIsInvisibleOffline()
    {
        var source = new FixtureDatabaseCitySource();
        var page = await source.GetDatabaseAsync(
            "fixture-target-primary/database/sales", DatabaseCityMetric.Cpu, 20, null, CancellationToken.None);

        var volumes = page!.TopQueryFamilies
            .Where(family => family.PlanDataVolume is not null)
            .Select(family => BigInteger.Parse(
                family.PlanDataVolume!.EstimatedBytesPerExecution, CultureInfo.InvariantCulture))
            .ToList();

        // The ladder's own cut points. If they move, this moves with them -- the point is that each
        // band stays populated, not that these particular numbers are right.
        var bands = new (string Name, BigInteger Low, BigInteger High)[]
        {
            ("bicycle", 0, 64L * 1024),
            ("car", 64L * 1024, 8L * 1024 * 1024),
            ("box van", 8L * 1024 * 1024, 512L * 1024 * 1024),
            ("semi-truck", 512L * 1024 * 1024, BigInteger.Pow(2, 96)),
        };

        foreach (var band in bands)
        {
            Assert.True(
                volumes.Any(value => value >= band.Low && value < band.High),
                $"No fixture family moves between {band.Low} and {band.High} bytes per execution, so the " +
                $"'{band.Name}' class cannot be seen without a live server. Fixture volumes: " +
                string.Join(", ", volumes.Select(value => value.ToString(CultureInfo.InvariantCulture))));
        }

        // Absent is not zero: a family whose plans stated no row size must stay absent, so the
        // "unknown vehicle" path is demonstrable too.
        Assert.Contains(page.TopQueryFamilies, family => family.PlanDataVolume is null);
        Assert.DoesNotContain(volumes, value => value.IsZero);

        // Per-object entries may sum to less than the total -- bytes read in another database are
        // real work but are not this page's to place -- and must never sum to more.
        foreach (var family in page.TopQueryFamilies.Where(item => item.PlanDataVolume is not null))
        {
            var volume = family.PlanDataVolume!;
            var placed = volume.ByObject.Aggregate(BigInteger.Zero, (sum, entry) =>
                sum + BigInteger.Parse(entry.EstimatedBytesPerExecution, CultureInfo.InvariantCulture));
            Assert.True(
                placed <= BigInteger.Parse(volume.EstimatedBytesPerExecution, CultureInfo.InvariantCulture),
                $"{family.FamilyId} places more bytes on buildings than its plans say it moves.");
        }

        // The off-page disclosure itself has to stay demonstrable, or nothing exercises the branch.
        Assert.Contains(page.TopQueryFamilies, family =>
            family.PlanDataVolume is { } volume &&
            volume.ByObject.Aggregate(BigInteger.Zero, (sum, entry) =>
                sum + BigInteger.Parse(entry.EstimatedBytesPerExecution, CultureInfo.InvariantCulture))
                < BigInteger.Parse(volume.EstimatedBytesPerExecution, CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task FixtureSourceRejectsTokensAcrossMetrics()
    {
        var source = new FixtureDatabaseCitySource();
        var first = await source.GetDatabaseAsync(
            "fixture-target-primary/database/sales", DatabaseCityMetric.Cpu, 1, null, CancellationToken.None);

        await Assert.ThrowsAsync<DatabaseCityPageTokenException>(() => source.GetDatabaseAsync(
            first!.DatabaseId, DatabaseCityMetric.Reads, 1, first.NextPageToken, CancellationToken.None));
    }
}
