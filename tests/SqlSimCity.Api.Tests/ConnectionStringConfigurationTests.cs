using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SqlSimCity.Collection.Catalog;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Covers the single-connection-string shortcut: one ordinary ADO.NET connection
/// string stands in for the field-by-field connection profile and the mounted
/// password file, and must land on exactly the same validated
/// <see cref="ConnectionProfile"/> the long-hand configuration produces.
/// </summary>
public sealed class ConnectionStringConfigurationTests
{
    private const string OnPremises =
        "Server=sql.internal.example,1433;Database=AppDb;User Id=monitor;Password=pa55w0rd!;TrustServerCertificate=true";

    private const string AzureSql =
        "Server=tcp:contoso.database.windows.net,1433;Database=AppDb;User Id=monitor;Password=pa55w0rd!";

    private static IConfiguration Configure(Dictionary<string, string?> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    private static ProbeCatalog LoadCatalog() => ApplicationInitialization.LoadProbeCatalog();

    // ---- Resolution order -------------------------------------------------

    [Fact]
    public void NoConnectionStringAnywhereResolvesToNull()
    {
        Assert.Null(SqlSimCityConnectionString.Resolve(Configure([])));
        Assert.Null(SqlSimCityConnectionString.Resolve(Configure([]), AtlasConfiguration.ConnectionStringKey));
    }

    [Fact]
    public void TheStandardConnectionStringsEntryIsResolved()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [$"ConnectionStrings:{SqlSimCityConnectionString.ConnectionStringName}"] = OnPremises,
        });

        Assert.Equal(OnPremises, SqlSimCityConnectionString.Resolve(configuration));
    }

    [Fact]
    public void TheUnprefixedEnvironmentVariableIsResolved()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [SqlSimCityConnectionString.EnvironmentVariableName] = OnPremises,
        });

        Assert.Equal(OnPremises, SqlSimCityConnectionString.Resolve(configuration));
    }

    [Fact]
    public void ASectionScopedKeyWinsOverTheSharedSources()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = OnPremises,
            [$"ConnectionStrings:{SqlSimCityConnectionString.ConnectionStringName}"] = AzureSql,
            [SqlSimCityConnectionString.EnvironmentVariableName] = AzureSql,
        });

        Assert.Equal(OnPremises, AtlasConfiguration.ResolveConnectionString(configuration));
    }

    [Fact]
    public void TheStandardEntryWinsOverTheEnvironmentVariable()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [$"ConnectionStrings:{SqlSimCityConnectionString.ConnectionStringName}"] = OnPremises,
            [SqlSimCityConnectionString.EnvironmentVariableName] = AzureSql,
        });

        Assert.Equal(OnPremises, SqlSimCityConnectionString.Resolve(configuration));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ABlankConnectionStringIsTreatedAsAbsentSoItCannotSilentlySelectConnectedMode(string blank)
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = blank,
        });

        Assert.Null(AtlasConfiguration.ResolveConnectionString(configuration));
        Assert.False(AtlasConfiguration.IsConnected(configuration));
    }

    [Fact]
    public void SurroundingWhitespaceIsTrimmedSoACopiedPastedValueStillParses()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = $"  {OnPremises}\n",
        });

        Assert.Equal(OnPremises, AtlasConfiguration.ResolveConnectionString(configuration));
    }

    // ---- Atlas ------------------------------------------------------------

    [Fact]
    public void AtlasStaysOnTheFixturePathWhenNoConnectionStringIsConfigured()
    {
        Assert.False(AtlasConfiguration.IsConnected(Configure([])));
    }

    [Theory]
    [InlineData(AtlasConfiguration.ConnectionStringKey)]
    [InlineData($"ConnectionStrings:{SqlSimCityConnectionString.ConnectionStringName}")]
    [InlineData(SqlSimCityConnectionString.EnvironmentVariableName)]
    public void AConnectionStringAloneSelectsConnectedAtlasWithoutAlsoSettingTheMode(string key)
    {
        var configuration = Configure(new Dictionary<string, string?> { [key] = OnPremises });

        Assert.True(AtlasConfiguration.IsConnected(configuration));
    }

    [Fact]
    public void AtlasBuildsTheSameValidatedProfileFromAConnectionStringAsFromFields()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = OnPremises,
        });

        var profile = AtlasConfiguration.BuildProfile(configuration);

        Assert.Equal("sql.internal.example", profile.Server.Host);
        Assert.Equal(1433, profile.Server.Port);
        Assert.Null(profile.Server.InstanceName);
        Assert.Equal("AppDb", profile.InitialDatabase);
        Assert.True(profile.TrustServerCertificate);
        var login = Assert.IsType<SqlLoginAuthenticationStrategy>(profile.Authentication);
        Assert.Equal("monitor", login.Username);
        Assert.Equal(
            ConnectionStringProfile.InlinePasswordSecretName,
            login.PasswordSecretReference.FileName);
    }

    [Fact]
    public void AtlasHonorsItsConfiguredProfileIdSoDiagnosticsStayStableAcrossBothPaths()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = OnPremises,
            ["Atlas:Connection:ProfileId"] = "atlas-secondary",
        });

        Assert.Equal("atlas-secondary", AtlasConfiguration.BuildProfile(configuration).Id.Value);
    }

    [Fact]
    public void AnAzureSqlConnectionStringDefaultsKnownDatabasesToItsOwnInitialCatalog()
    {
        // Azure SQL Database cannot enumerate sibling databases, and AtlasCollector
        // refuses to probe with an empty list, so the one database the connection
        // string already names is the only sensible default.
        var configuration = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = AzureSql,
        });

        Assert.Equal(["AppDb"], AtlasConfiguration.BuildCollectionOptions(configuration).KnownDatabases);
    }

    [Fact]
    public void ExplicitKnownDatabasesWinOverTheAzureSqlFallback()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = AzureSql,
            ["Atlas:KnownDatabases:0"] = "Reporting",
        });

        Assert.Equal(["Reporting"], AtlasConfiguration.BuildCollectionOptions(configuration).KnownDatabases);
    }

    [Fact]
    public void AnOnPremisesConnectionStringLeavesKnownDatabasesEmptySoTheServerIsEnumerated()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = OnPremises,
        });

        Assert.Empty(AtlasConfiguration.BuildCollectionOptions(configuration).KnownDatabases);
    }

    [Fact]
    public void TheQueryStoreCadenceIsConfiguredSeparatelyFromTheAtlasCycleAndDefaultsToFifteenMinutes()
    {
        var defaults = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = OnPremises,
        });
        var configured = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = OnPremises,
            ["Atlas:QueryStoreRefreshIntervalSeconds"] = "300",
        });

        Assert.Equal(
            TimeSpan.FromMinutes(15),
            AtlasConfiguration.BuildCollectionOptions(defaults).QueryStoreRefreshInterval);
        Assert.Equal(
            TimeSpan.FromMinutes(5),
            AtlasConfiguration.BuildCollectionOptions(configured).QueryStoreRefreshInterval);
        Assert.Equal(
            TimeSpan.FromSeconds(60),
            AtlasConfiguration.BuildCollectionOptions(defaults).RefreshInterval);
    }

    [Fact]
    public void AnAtlasAlreadySlowerThanTheQueryStoreDefaultKeepsItsOwnCadenceInsteadOfFailingToStart()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = OnPremises,
            ["Atlas:RefreshIntervalSeconds"] = "1800",
            ["Atlas:StaleAfterSeconds"] = "1800",
        });

        var options = AtlasConfiguration.BuildCollectionOptions(configuration);

        Assert.Equal(TimeSpan.FromMinutes(30), options.QueryStoreRefreshInterval);
    }

    [Fact]
    public void AQueryStoreCadenceFasterThanTheAtlasCycleIsRefusedRatherThanQuietlyIgnored()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = OnPremises,
            ["Atlas:RefreshIntervalSeconds"] = "1800",
            ["Atlas:StaleAfterSeconds"] = "1800",
            ["Atlas:QueryStoreRefreshIntervalSeconds"] = "900",
        });

        Assert.Throws<ArgumentOutOfRangeException>(() => AtlasConfiguration.BuildCollectionOptions(configuration));
    }

    [Fact]
    public async Task AtlasServesTheConnectionStringPasswordInlineInsteadOfFromTheSecretsDirectory()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = OnPremises,
        });

        var provider = AtlasConfiguration.BuildSecretProvider(configuration);

        Assert.IsType<InlineSecretProvider>(provider);
        using var secret = await provider.ReadAsync(
            new SecretFileReference(ConnectionStringProfile.InlinePasswordSecretName), CancellationToken.None);
        Assert.Equal("pa55w0rd!", secret.UseAsUtf8Text(chars => chars.ToString()));
    }

    [Fact]
    public async Task AnInlineProviderRefusesEveryOtherSecretSoItCannotStandInForMountedFiles()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = OnPremises,
        });

        var provider = AtlasConfiguration.BuildSecretProvider(configuration);

        await Assert.ThrowsAsync<SecretResolutionException>(() =>
            provider.ReadAsync(new SecretFileReference("client-certificate"), CancellationToken.None));
    }

    [Fact]
    public void TheFieldConfiguredAtlasPathStillUsesTheMountedSecretsDirectory()
    {
        Assert.IsType<FileSecretFileProvider>(AtlasConfiguration.BuildSecretProvider(Configure([])));
    }

    [Fact]
    public void AnInvalidAtlasConnectionStringFailsClosedRatherThanFallingBackToFields()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [AtlasConfiguration.ConnectionStringKey] = "Server=sql.example;Database=AppDb;Encrypt=false",
        });

        Assert.Throws<ConnectionProfileValidationException>(() => AtlasConfiguration.BuildProfile(configuration));
    }

    // ---- Live incidents ---------------------------------------------------

    [Theory]
    [InlineData("LiveIncidents:Connection:ConnectionString")]
    [InlineData($"ConnectionStrings:{SqlSimCityConnectionString.ConnectionStringName}")]
    [InlineData(SqlSimCityConnectionString.EnvironmentVariableName)]
    public void AConnectionStringAloneSelectsConnectedLiveIncidents(string key)
    {
        var configuration = Configure(new Dictionary<string, string?> { [key] = OnPremises });
        var services = new ServiceCollection();

        Assert.True(LiveIncidentsServiceCollectionExtensions.IsConnected(configuration));

        services.AddLiveIncidents(configuration, LoadCatalog());
        using var provider = services.BuildServiceProvider();

        Assert.IsType<LiveIncidentCollector>(provider.GetRequiredService<ILiveIncidentCollector>());
        Assert.IsType<SqlLiveIncidentProbeExecutor>(provider.GetRequiredService<ILiveIncidentProbeExecutor>());
    }

    [Fact]
    public void LiveIncidentsServesTheConnectionStringPasswordInline()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            ["LiveIncidents:Connection:ConnectionString"] = OnPremises,
        });
        var services = new ServiceCollection();

        services.AddLiveIncidents(configuration, LoadCatalog());
        using var provider = services.BuildServiceProvider();

        Assert.IsType<InlineSecretProvider>(provider.GetRequiredKeyedService<ISecretFileProvider>(
            LiveIncidentsServiceCollectionExtensions.ConnectionFactoryServiceKey));
    }

    [Fact]
    public void LiveIncidentsNeedsNoTargetIdOrPlatformWhenAConnectionStringSuppliesTheConnection()
    {
        // The whole point of the shortcut: nothing beyond the connection string is
        // required, even though the field-by-field path demands all three.
        var configuration = Configure(new Dictionary<string, string?>
        {
            ["LiveIncidents:Connection:ConnectionString"] = AzureSql,
        });
        var services = new ServiceCollection();

        services.AddLiveIncidents(configuration, LoadCatalog());
        using var provider = services.BuildServiceProvider();

        Assert.IsType<LiveIncidentCollector>(provider.GetRequiredService<ILiveIncidentCollector>());
    }

    [Fact]
    public void AnExplicitLiveIncidentsPlatformStillWinsOverTheInferredOne()
    {
        // Managed Instance shares the Azure SQL host suffix, so it must remain
        // statable even when the host name would otherwise infer Azure SQL Database.
        var configuration = Configure(new Dictionary<string, string?>
        {
            ["LiveIncidents:Connection:ConnectionString"] = AzureSql,
            ["LiveIncidents:Connection:Platform"] = "AzureSqlManagedInstance",
        });
        var services = new ServiceCollection();

        services.AddLiveIncidents(configuration, LoadCatalog());
        using var provider = services.BuildServiceProvider();

        Assert.IsType<LiveIncidentCollector>(provider.GetRequiredService<ILiveIncidentCollector>());
    }

    [Fact]
    public void AnInvalidLiveIncidentsConnectionStringFailsDuringRegistrationNotAtFirstRequest()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            ["LiveIncidents:Connection:ConnectionString"] = "Server=sql.example;Database=AppDb;Authentication=Active Directory Default",
        });
        var services = new ServiceCollection();

        var catalog = LoadCatalog();
        Assert.Throws<LiveIncidentsConfigurationException>(
            () => services.AddLiveIncidents(configuration, catalog));
    }

    // ---- Platform inference -----------------------------------------------

    [Theory]
    [InlineData(AzureSql, EnginePlatform.AzureSqlDatabase)]
    [InlineData(OnPremises, EnginePlatform.SqlServerOnPremises)]
    public void ThePlatformIsInferredFromTheHostNameBecauseAConnectionStringCannotStateIt(
        string connectionString, EnginePlatform expected)
    {
        var parsed = ConnectionStringProfile.Parse(connectionString, new ConnectionProfileId("test"));

        Assert.Equal(expected, SqlSimCityConnectionString.DefaultPlatform(parsed));
    }

    // ---- Conflict guard ---------------------------------------------------

    [Theory]
    [InlineData("Host", "other.example")]
    [InlineData("Instance", "SQLEXPRESS")]
    [InlineData("Port", "1433")]
    [InlineData("InitialDatabase", "OtherDb")]
    [InlineData("ConnectTimeoutSeconds", "15")]
    [InlineData("CommandTimeoutSeconds", "30")]
    [InlineData("MaxPoolSize", "20")]
    [InlineData("Encryption", "Strict")]
    [InlineData("HostNameInCertificate", "cert.example")]
    [InlineData("TrustServerCertificate", "false")]
    [InlineData("Authentication:Mode", "Kerberos")]
    public void AtlasRejectsAConnectionStringCombinedWithAFieldItWouldOverride(string key, string value)
    {
        // A shared ConnectionStrings__SqlSimCity is conventionally auto-injected by
        // hosting platforms. Without this guard, one appearing in the environment
        // would silently replace a hardened field profile -- its authentication
        // strategy, its TLS trust setting, and its mounted password file.
        var configuration = Configure(new Dictionary<string, string?>
        {
            [$"ConnectionStrings:{SqlSimCityConnectionString.ConnectionStringName}"] = OnPremises,
            [$"Atlas:Connection:{key}"] = value,
        });

        var ex = Assert.Throws<InvalidOperationException>(
            () => AtlasConfiguration.TryParseConnectionString(configuration));

        Assert.Contains("cannot be combined with a connection string", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AtlasStillAllowsTheProfileIdLabelAlongsideAConnectionString()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [$"ConnectionStrings:{SqlSimCityConnectionString.ConnectionStringName}"] = OnPremises,
            ["Atlas:Connection:ProfileId"] = "custom-label",
        });

        var parsed = AtlasConfiguration.TryParseConnectionString(configuration);

        Assert.Equal("custom-label", parsed!.Profile.Id.Value);
    }

    [Theory]
    [InlineData("Server:Host", "other.example")]
    [InlineData("Database", "OtherDb")]
    [InlineData("Encryption", "Strict")]
    [InlineData("TrustServerCertificate", "false")]
    [InlineData("HostNameInCertificate", "cert.example")]
    [InlineData("Timeouts:ConnectSeconds", "15")]
    [InlineData("Pool:MaxPoolSize", "5")]
    [InlineData("Authentication:Mode", "Kerberos")]
    public void LiveIncidentsRejectsAConnectionStringCombinedWithAFieldItWouldOverride(string key, string value)
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [$"ConnectionStrings:{SqlSimCityConnectionString.ConnectionStringName}"] = OnPremises,
            [$"LiveIncidents:Connection:{key}"] = value,
        });

        var ex = Assert.Throws<LiveIncidentsConfigurationException>(
            () => new ServiceCollection().AddLiveIncidents(configuration, LoadCatalog()));

        Assert.Contains("cannot be combined with a connection string", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LiveIncidentsStillAllowsLabelsAConnectionStringCannotExpress()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            [$"ConnectionStrings:{SqlSimCityConnectionString.ConnectionStringName}"] = AzureSql,
            ["LiveIncidents:Connection:TargetId"] = "reporting",
            ["LiveIncidents:Connection:DisplayName"] = "Reporting replica",
            ["LiveIncidents:Connection:Platform"] = nameof(EnginePlatform.AzureSqlDatabase),
            ["LiveIncidents:Connection:Secrets:Directory"] = "/run/secrets",
        });

        var services = new ServiceCollection().AddLiveIncidents(configuration, LoadCatalog());

        Assert.Contains(services, d => d.ServiceType == typeof(ILiveIncidentCollector));
    }

    [Fact]
    public void NoConflictIsRaisedWhenNoConnectionStringIsConfigured()
    {
        var configuration = Configure(new Dictionary<string, string?>
        {
            ["Atlas:Connection:Host"] = "sql.internal.example",
        });

        Assert.Null(AtlasConfiguration.TryParseConnectionString(configuration));
    }
}