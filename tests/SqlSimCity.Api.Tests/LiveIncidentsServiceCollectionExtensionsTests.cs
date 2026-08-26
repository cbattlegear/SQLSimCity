using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SqlSimCity.Collection.Catalog;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Domain;
using SqlSimCity.SqlServer;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Exercises requirement 1: <c>LiveIncidents:Mode</c> defaults to the no-credentials fixture path,
/// and opting into <c>Connected</c> mode either wires a real <see cref="SqlConnectionFactory"/>-
/// backed collector or fails synchronously here -- during service registration, before any host
/// can build or serve traffic -- rather than at first request.
/// </summary>
public sealed class LiveIncidentsServiceCollectionExtensionsTests
{
    private static ProbeCatalog LoadCatalog() => ApplicationInitialization.LoadProbeCatalog();

    [Fact]
    public void DefaultConfigurationRegistersTheFixtureCollectorWithNoConnectedModeFieldsRequired()
    {
        var configuration = BuildConfiguration([]);
        var services = new ServiceCollection();

        services.AddLiveIncidents(configuration, LoadCatalog());
        using var provider = services.BuildServiceProvider();

        Assert.IsType<FixtureLiveIncidentCollector>(provider.GetRequiredService<ILiveIncidentCollector>());
    }

    [Fact]
    public void ExplicitFixtureModeRegistersTheFixtureCollector()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["LiveIncidents:Mode"] = "Fixture",
        });
        var services = new ServiceCollection();

        services.AddLiveIncidents(configuration, LoadCatalog());
        using var provider = services.BuildServiceProvider();

        Assert.IsType<FixtureLiveIncidentCollector>(provider.GetRequiredService<ILiveIncidentCollector>());
    }

    [Fact]
    public void ConnectedModeWithACompleteConfigurationRegistersARealSqlBackedCollector()
    {
        var configuration = BuildConfiguration(ValidConnectedConfiguration());
        var services = new ServiceCollection();

        services.AddLiveIncidents(configuration, LoadCatalog());
        using var provider = services.BuildServiceProvider();

        Assert.IsType<LiveIncidentCollector>(provider.GetRequiredService<ILiveIncidentCollector>());
        Assert.IsType<SqlLiveIncidentProbeExecutor>(provider.GetRequiredService<ILiveIncidentProbeExecutor>());
        Assert.IsType<SqlConnectionFactory>(provider.GetRequiredKeyedService<ISqlConnectionFactory>(
            LiveIncidentsServiceCollectionExtensions.ConnectionFactoryServiceKey));
    }

    [Fact]
    public async Task DisposingTheContainerDisposesTheRegisteredSqlConnectionFactory()
    {
        // Requirement 17: the container-owned ISqlConnectionFactory singleton must be disposed
        // with the container, never leaked. SqlConnectionFactory.OpenAsync throws
        // ObjectDisposedException once shutdown has started, which is the only externally
        // observable proof of disposal available without reflection.
        var configuration = BuildConfiguration(ValidConnectedConfiguration());
        var services = new ServiceCollection();
        services.AddLiveIncidents(configuration, LoadCatalog());
        var provider = services.BuildServiceProvider();
        var factory = provider.GetRequiredKeyedService<ISqlConnectionFactory>(
            LiveIncidentsServiceCollectionExtensions.ConnectionFactoryServiceKey);

        await provider.DisposeAsync();

        var profile = new ConnectionProfile(
            new ConnectionProfileId("primary"),
            new ServerAddress("sql.internal.example"),
            "AppDb",
            new ConnectionTimeouts(15, 10),
            new PoolBounds(0, 5),
            EncryptionPolicy.Mandatory,
            new SqlServer.Auth.ManagedIdentityAuthenticationStrategy());
        await Assert.ThrowsAsync<ObjectDisposedException>(
            () => factory.OpenAsync(profile, CancellationToken.None));
    }

    [Fact]
    public void ConnectedModeDoesNotReplaceAnotherCollectorsConnectionFactory()
    {
        var services = new ServiceCollection();
        var existing = new SqlConnectionFactory(new SqlServer.Secrets.FileSecretFileProvider(
            new SqlServer.Secrets.SecretFileProviderOptions
            {
                SecretsDirectory = Path.GetTempPath(),
            }));
        services.AddSingleton<ISqlConnectionFactory>(existing);

        services.AddLiveIncidents(BuildConfiguration(ValidConnectedConfiguration()), LoadCatalog());
        using var provider = services.BuildServiceProvider();

        Assert.Same(existing, provider.GetRequiredService<ISqlConnectionFactory>());
        Assert.NotSame(existing, provider.GetRequiredKeyedService<ISqlConnectionFactory>(
            LiveIncidentsServiceCollectionExtensions.ConnectionFactoryServiceKey));
    }

    [Fact]
    public void ConnectedModeWithoutAPlatformFailsClosedBeforeAnyServiceIsResolved()
    {
        var overrides = ValidConnectedConfiguration();
        overrides.Remove("LiveIncidents:Connection:Platform");
        var configuration = BuildConfiguration(overrides);
        var services = new ServiceCollection();

        // Requirement 1/3: this must throw synchronously from AddLiveIncidents -- i.e. before the
        // host is even built -- not lazily the first time the collector is resolved from DI.
        var ex = Assert.Throws<LiveIncidentsConfigurationException>(
            () => services.AddLiveIncidents(configuration, LoadCatalog()));
        Assert.Contains("Platform", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ConnectedModeWithAnUnknownOrUnsupportedPlatformIsRejected()
    {
        foreach (var badPlatform in new[] { "Unknown", "Unsupported", "NotARealPlatform" })
        {
            var overrides = ValidConnectedConfiguration();
            overrides["LiveIncidents:Connection:Platform"] = badPlatform;
            var configuration = BuildConfiguration(overrides);
            var services = new ServiceCollection();

            Assert.Throws<LiveIncidentsConfigurationException>(
                () => services.AddLiveIncidents(configuration, LoadCatalog()));
        }
    }

    [Fact]
    public void ConnectedModeWithoutAServerHostFailsClosed()
    {
        var overrides = ValidConnectedConfiguration();
        overrides.Remove("LiveIncidents:Connection:Server:Host");
        var configuration = BuildConfiguration(overrides);
        var services = new ServiceCollection();

        Assert.Throws<LiveIncidentsConfigurationException>(
            () => services.AddLiveIncidents(configuration, LoadCatalog()));
    }

    [Fact]
    public void ConnectedModeWithoutAnAuthenticationModeFailsClosed()
    {
        var overrides = ValidConnectedConfiguration();
        overrides.Remove("LiveIncidents:Connection:Authentication:Mode");
        var configuration = BuildConfiguration(overrides);
        var services = new ServiceCollection();

        Assert.Throws<LiveIncidentsConfigurationException>(
            () => services.AddLiveIncidents(configuration, LoadCatalog()));
    }

    [Fact]
    public void ConnectedModeSqlLoginWithoutAPasswordSecretFileFailsClosed()
    {
        var overrides = ValidConnectedConfiguration();
        overrides.Remove("LiveIncidents:Connection:Authentication:PasswordSecretFile");
        var configuration = BuildConfiguration(overrides);
        var services = new ServiceCollection();

        var ex = Assert.Throws<LiveIncidentsConfigurationException>(
            () => services.AddLiveIncidents(configuration, LoadCatalog()));
        Assert.Contains("PasswordSecretFile", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ConnectedModeWithManagedIdentityAuthenticationNeedsNoPassword()
    {
        var overrides = ValidConnectedConfiguration();
        overrides.Remove("LiveIncidents:Connection:Authentication:Username");
        overrides.Remove("LiveIncidents:Connection:Authentication:PasswordSecretFile");
        overrides["LiveIncidents:Connection:Authentication:Mode"] = "ManagedIdentity";
        var configuration = BuildConfiguration(overrides);
        var services = new ServiceCollection();

        services.AddLiveIncidents(configuration, LoadCatalog());
        using var provider = services.BuildServiceProvider();

        Assert.IsType<LiveIncidentCollector>(provider.GetRequiredService<ILiveIncidentCollector>());
    }

    [Theory]
    [InlineData("ServicePrincipalCertificate", "CertificateSecretFile")]
    [InlineData("ServicePrincipalSecret", "ClientSecretFile")]
    public void ConnectedModeSupportsExplicitServicePrincipalAuthentication(
        string mode,
        string secretKey)
    {
        var overrides = ValidConnectedConfiguration();
        overrides.Remove("LiveIncidents:Connection:Authentication:Username");
        overrides.Remove("LiveIncidents:Connection:Authentication:PasswordSecretFile");
        overrides["LiveIncidents:Connection:Authentication:Mode"] = mode;
        overrides["LiveIncidents:Connection:Authentication:TenantId"] = "6a72031d-4f77-47af-b061-84ad7083bb16";
        overrides["LiveIncidents:Connection:Authentication:ClientId"] = "da0fa149-46b6-4ff8-82a9-c98788df11b2";
        overrides[$"LiveIncidents:Connection:Authentication:{secretKey}"] =
            secretKey == "CertificateSecretFile" ? "client.pfx" : "client-secret";
        var services = new ServiceCollection();

        services.AddLiveIncidents(BuildConfiguration(overrides), LoadCatalog());
        using var provider = services.BuildServiceProvider();

        Assert.IsType<LiveIncidentCollector>(provider.GetRequiredService<ILiveIncidentCollector>());
    }

    [Fact]
    public void UnrecognizedModeFailsClosed()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["LiveIncidents:Mode"] = "SomethingElse",
        });
        var services = new ServiceCollection();

        Assert.Throws<LiveIncidentsConfigurationException>(
            () => services.AddLiveIncidents(configuration, LoadCatalog()));
    }

    private static Dictionary<string, string?> ValidConnectedConfiguration() => new()
    {
        ["LiveIncidents:Mode"] = "Connected",
        ["LiveIncidents:Connection:TargetId"] = "primary",
        ["LiveIncidents:Connection:DisplayName"] = "Primary SQL Server",
        ["LiveIncidents:Connection:Platform"] = "SqlServerOnPremises",
        ["LiveIncidents:Connection:Server:Host"] = "sql.internal.example",
        ["LiveIncidents:Connection:Database"] = "AppDb",
        ["LiveIncidents:Connection:Authentication:Mode"] = "SqlLogin",
        ["LiveIncidents:Connection:Authentication:Username"] = "monitor",
        ["LiveIncidents:Connection:Authentication:PasswordSecretFile"] = "sql-monitor-password",
    };

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> overrides) =>
        new ConfigurationBuilder().AddInMemoryCollection(overrides).Build();
    // --- Issue #81 part 3: the sample bounds an operator can move. ---
    //
    // The bounds exist because a live snapshot's size is set by the watched workload rather than by
    // anything SqlSimCity controls. They are deliberately adjustable: 0 restores the unbounded
    // behaviour for an operator who would rather pay for it than lose statement text, so the
    // defaults are a starting point and never a ceiling on what the tool can report.

    [Fact]
    public void SampleBoundsAreOptionalAndFallBackToTheMeasuredDefaults()
    {
        var configuration = BuildConfiguration(ValidConnectedConfiguration());
        var services = new ServiceCollection();

        services.AddLiveIncidents(configuration, LoadCatalog());
        using var provider = services.BuildServiceProvider();

        var executor = Assert.IsType<SqlLiveIncidentProbeExecutor>(
            provider.GetRequiredService<ILiveIncidentProbeExecutor>());
        Assert.Equal(1_000, executor.MaxRequestRows);
        Assert.Equal(16_384, executor.MaxTextLength);
        Assert.Equal(1_000, executor.MaxTempdbRows);
    }

    [Theory]
    [InlineData("MaxRequestRows")]
    [InlineData("MaxTextLength")]
    [InlineData("MaxTempdbRows")]
    public void ZeroRemovesABoundEntirelyRatherThanCappingAtNothing(string key)
    {
        var settings = ValidConnectedConfiguration();
        settings[$"LiveIncidents:SampleBounds:{key}"] = "0";
        var services = new ServiceCollection();

        services.AddLiveIncidents(BuildConfiguration(settings), LoadCatalog());
        using var provider = services.BuildServiceProvider();

        var executor = Assert.IsType<SqlLiveIncidentProbeExecutor>(
            provider.GetRequiredService<ILiveIncidentProbeExecutor>());
        var resolved = key switch
        {
            "MaxRequestRows" => executor.MaxRequestRows,
            "MaxTextLength" => executor.MaxTextLength,
            _ => executor.MaxTempdbRows,
        };
        Assert.Null(resolved);
    }

    // "-1" is a plausible guess at "unlimited", and 0 already means that here. Accepting it would
    // either cap at nothing or cap at everything, and the two misreport the instance in opposite
    // directions, so it fails closed during registration instead.
    [Theory]
    [InlineData("MaxRequestRows")]
    [InlineData("MaxTextLength")]
    [InlineData("MaxTempdbRows")]
    public void ANegativeBoundIsRejectedDuringRegistrationNotGuessedAtRuntime(string key)
    {
        var settings = ValidConnectedConfiguration();
        settings[$"LiveIncidents:SampleBounds:{key}"] = "-1";
        var services = new ServiceCollection();

        var ex = Assert.Throws<LiveIncidentsConfigurationException>(
            () => services.AddLiveIncidents(BuildConfiguration(settings), LoadCatalog()));
        Assert.Contains($"LiveIncidents:SampleBounds:{key}", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AConfiguredBoundIsAcceptedSoAnOperatorCanRaiseTheTextCap()
    {
        var settings = ValidConnectedConfiguration();
        settings["LiveIncidents:SampleBounds:MaxTextLength"] = "1048576";
        var services = new ServiceCollection();

        services.AddLiveIncidents(BuildConfiguration(settings), LoadCatalog());
        using var provider = services.BuildServiceProvider();

        var executor = Assert.IsType<SqlLiveIncidentProbeExecutor>(
            provider.GetRequiredService<ILiveIncidentProbeExecutor>());
        Assert.Equal(1_048_576, executor.MaxTextLength);
    }
}
