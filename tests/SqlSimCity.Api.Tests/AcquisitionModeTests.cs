using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using SqlSimCity.Archive;
using SqlSimCity.Domain;

namespace SqlSimCity.Api.Tests;

public sealed class AcquisitionModeTests
{
    [Fact]
    public async Task ArchiveCompositionServesCapturedCapabilitiesWithoutConnectedCollectors()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Fixtures");
        const string fileName = "format1-findings-before-removal.ssca";
        using var archive = ArchiveSource.Open(new ArchiveSourceOptions(directory, fileName));
        var expected = ((ICapabilitiesSource)archive).GetCurrent();
        await using var factory = new WebApplicationFactory<ApiAssemblyMarker>()
            .WithWebHostBuilder(builder =>
            {
                builder.UseSetting("Acquisition:Mode", "Archive");
                builder.UseSetting("Acquisition:Archive:AllowedDirectory", directory);
                builder.UseSetting("Acquisition:Archive:FileName", fileName);
            });
        using var client = factory.CreateClient();
        var source = Assert.IsType<ArchiveSource>(factory.Services.GetRequiredService<ICapabilitiesSource>());
        var actual = ((ICapabilitiesSource)source).GetCurrent();
        Assert.NotEmpty(actual.Targets);
        Assert.Equal(expected.GeneratedAt, actual.GeneratedAt);
        Assert.Equal(expected.Targets.Select(target => target.TargetId), actual.Targets.Select(target => target.TargetId));
        Assert.Equal(expected.Targets.Select(target => target.SourceTimestamp), actual.Targets.Select(target => target.SourceTimestamp));
        Assert.Null(factory.Services.GetService<ConnectedCapabilitiesSource>());
        using var response = await client.GetAsync(new Uri("/api/v1/capabilities", UriKind.Relative));
        response.EnsureSuccessStatusCode();
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        Assert.Equal("{\"status\":\"ready\"}", await client.GetStringAsync("/readyz"));
        var info = await client.GetStringAsync("/api/v1/archive");
        Assert.DoesNotContain("findings", info, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ruleVersions", info, StringComparison.Ordinal);
        using var retired = await client.GetAsync(new Uri("/api/v1/findings/export", UriKind.Relative));
        Assert.Equal(System.Net.HttpStatusCode.Gone, retired.StatusCode);
        Assert.Equal("application/json", retired.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public void ArchiveModeRejectsEdgeIngestionBeforeServing()
    {
        using var factory = new WebApplicationFactory<ApiAssemblyMarker>()
            .WithWebHostBuilder(builder =>
            {
                builder.UseSetting("Acquisition:Mode", "Archive");
                builder.UseSetting("EdgeIngestion:Enabled", "true");
            });

        var exception = Assert.ThrowsAny<Exception>(() => factory.CreateClient());

        Assert.Contains("edge ingestion", exception.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void FixtureModeRejectsEdgeIngestionBeforeServing()
    {
        using var factory = new WebApplicationFactory<ApiAssemblyMarker>()
            .WithWebHostBuilder(builder => builder.UseSetting("EdgeIngestion:Enabled", "true"));

        var exception = Assert.ThrowsAny<Exception>(() => factory.CreateClient());

        Assert.Contains("only when Acquisition:Mode=Edge", exception.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void EdgeModeRequiresIngestionBeforeServing()
    {
        using var factory = new WebApplicationFactory<ApiAssemblyMarker>()
            .WithWebHostBuilder(builder =>
            {
                builder.UseSetting("Acquisition:Mode", "Edge");
                builder.UseSetting("Acquisition:Edge:TargetId", "target-1");
            });

        var exception = Assert.ThrowsAny<Exception>(() => factory.CreateClient());

        Assert.Contains("requires edge ingestion", exception.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("Atlas:Mode", "Connected", "connected Atlas")]
    [InlineData("QueryStoreHistory:Mode", "Connected", "Query Store")]
    [InlineData("LiveIncidents:Mode", "Connected", "live incidents")]
    [InlineData("ProtectedStorage:Enabled", "true", "protected storage")]
    public void EdgeModeRejectsLocalOrProtectedSources(
        string key,
        string value,
        string expected)
    {
        using var factory = new WebApplicationFactory<ApiAssemblyMarker>()
            .WithWebHostBuilder(builder =>
            {
                builder.UseSetting("Acquisition:Mode", "Edge");
                builder.UseSetting("Acquisition:Edge:TargetId", "target-1");
                builder.UseSetting("EdgeIngestion:Enabled", "true");
                builder.UseSetting(key, value);
            });

        var exception = Assert.ThrowsAny<Exception>(() => factory.CreateClient());

        Assert.Contains(expected, exception.ToString(), StringComparison.OrdinalIgnoreCase);
    }
}
