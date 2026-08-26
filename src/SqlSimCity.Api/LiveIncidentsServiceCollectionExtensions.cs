using Microsoft.Extensions.Configuration;
using SqlSimCity.Collection.Catalog;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Api;

/// <summary>
/// Wires the live-incident sampling seam into a host's DI container. <c>LiveIncidents:Mode</c>
/// defaults to <see cref="LiveIncidentsMode.Fixture"/> -- the existing no-credentials path is
/// completely unchanged when an operator configures nothing. Setting it to <c>Connected</c> opts
/// into a real <see cref="SqlConnectionFactory"/>-backed <see cref="LiveIncidentCollector"/>, but
/// only after <see cref="LiveIncidentsConnectionOptions"/> is fully validated here, synchronously,
/// during service registration -- before <c>WebApplication.Build()</c> even runs, let alone
/// <c>app.Run()</c> -- so a misconfigured Connected mode fails closed and never serves traffic
/// (requirement 1). Every validation failure is a <see cref="LiveIncidentsConfigurationException"/>
/// built only from section/key names, never a secret or resolved value.
/// </summary>
public static class LiveIncidentsServiceCollectionExtensions
{
    public const string ConnectionFactoryServiceKey = "LiveIncidents";

    private const string DefaultTargetId = "primary";
    private const string DefaultDisplayName = "SQL Server";

    /// <summary>
    /// The <c>LiveIncidents:Connection</c> keys a connection string already
    /// supplies. Configuring both is rejected rather than silently resolved.
    /// <c>TargetId</c>, <c>DisplayName</c>, <c>Platform</c>, and <c>Secrets</c>
    /// are absent on purpose: a connection string cannot express them, so they
    /// stay usable alongside one.
    /// </summary>
    private static readonly string[] ConnectionStringProfileKeys =
    [
        nameof(LiveIncidentsConnectionOptions.Server),
        nameof(LiveIncidentsConnectionOptions.Database),
        nameof(LiveIncidentsConnectionOptions.Encryption),
        nameof(LiveIncidentsConnectionOptions.TrustServerCertificate),
        nameof(LiveIncidentsConnectionOptions.HostNameInCertificate),
        nameof(LiveIncidentsConnectionOptions.Timeouts),
        nameof(LiveIncidentsConnectionOptions.Pool),
        nameof(LiveIncidentsConnectionOptions.Authentication),
    ];

    /// <summary>
    /// Connected when <c>LiveIncidents:Mode</c> says so, or when a connection
    /// string is configured. Program startup uses this to keep its own
    /// mode-conflict checks in step with what <see cref="AddLiveIncidents"/> registers.
    /// </summary>
    public static bool IsConnected(
        IConfiguration configuration,
        string sectionName = LiveIncidentsOptions.SectionName)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return string.Equals(
                configuration[$"{sectionName}:{nameof(LiveIncidentsOptions.Mode)}"],
                nameof(LiveIncidentsMode.Connected),
                StringComparison.OrdinalIgnoreCase)
            || ResolveConnectionString(configuration, sectionName) is not null;
    }

    private static string? ResolveConnectionString(IConfiguration configuration, string sectionName) =>
        SqlSimCityConnectionString.Resolve(
            configuration,
            $"{sectionName}:{nameof(LiveIncidentsOptions.Connection)}:{nameof(LiveIncidentsConnectionOptions.ConnectionString)}");

    public static IServiceCollection AddLiveIncidents(
        this IServiceCollection services,
        IConfiguration configuration,
        ProbeCatalog probeCatalog,
        string sectionName = LiveIncidentsOptions.SectionName)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(probeCatalog);

        var options = new LiveIncidentsOptions();
        configuration.GetSection(sectionName).Bind(options);

        if (!Enum.TryParse<LiveIncidentsMode>(options.Mode, ignoreCase: true, out var mode))
        {
            throw new LiveIncidentsConfigurationException(
                $"{sectionName}:{nameof(LiveIncidentsOptions.Mode)} '{options.Mode}' must be 'Fixture' or 'Connected'.");
        }

        // A configured connection string is itself an opt-in to a real target, so
        // it selects Connected without also having to set the mode.
        var connectionString = ResolveConnectionString(configuration, sectionName);
        if (connectionString is not null)
        {
            SqlSimCityConnectionString.EnsureNoFieldConflict(
                configuration,
                $"{sectionName}:{nameof(LiveIncidentsOptions.Connection)}",
                ConnectionStringProfileKeys,
                message => new LiveIncidentsConfigurationException(message));

            mode = LiveIncidentsMode.Connected;
        }

        switch (mode)
        {
            case LiveIncidentsMode.Fixture:
                // Default, no-credentials live-incident path (requirement 7): the fixture
                // collector, never a real SQL Server connection, backs /api/v1/live and the
                // SignalR push until an operator opts a real ILiveIncidentCollector in.
                services.AddSingleton<ILiveIncidentCollector, FixtureLiveIncidentCollector>();
                break;

            case LiveIncidentsMode.Connected:
                RegisterConnected(services, options.Connection, options.SampleBounds, probeCatalog, sectionName, connectionString);
                break;

            default:
                throw new LiveIncidentsConfigurationException(
                    $"{sectionName}:{nameof(LiveIncidentsOptions.Mode)} '{options.Mode}' is not a recognized live-incidents mode.");
        }

        return services;
    }

    private static void RegisterConnected(
        IServiceCollection services,
        LiveIncidentsConnectionOptions connection,
        LiveIncidentsSampleBoundsOptions sampleBounds,
        ProbeCatalog probeCatalog,
        string sectionName,
        string? connectionString)
    {
        var connectionSection = $"{sectionName}:{nameof(LiveIncidentsOptions.Connection)}";
        var boundsSection = $"{sectionName}:{nameof(LiveIncidentsOptions.SampleBounds)}";
        var maxRequestRows = ParseBound(
            sampleBounds.MaxRequestRows, boundsSection, nameof(LiveIncidentsSampleBoundsOptions.MaxRequestRows));
        var maxTextLength = ParseBound(
            sampleBounds.MaxTextLength, boundsSection, nameof(LiveIncidentsSampleBoundsOptions.MaxTextLength));
        var maxTempdbRows = ParseBound(
            sampleBounds.MaxTempdbRows, boundsSection, nameof(LiveIncidentsSampleBoundsOptions.MaxTempdbRows));

        // Building the profile, platform, and secret provider now -- not lazily inside a
        // service factory -- guarantees every validation exception below surfaces the moment
        // this method runs, which callers await before the host can start serving traffic.
        var parsed = connectionString is null
            ? null
            : ParseConnectionString(connectionString, connection, connectionSection);

        var platform = parsed is null
            ? ParsePlatform(connection.Platform, connectionSection)
            : string.IsNullOrWhiteSpace(connection.Platform)
                ? SqlSimCityConnectionString.DefaultPlatform(parsed)
                : ParsePlatform(connection.Platform, connectionSection);
        var profile = parsed?.Profile ?? BuildConnectionProfile(connection, connectionSection);
        var targetId = parsed is null
            ? RequireNonBlank(connection.TargetId, connectionSection, nameof(LiveIncidentsConnectionOptions.TargetId))
            : connection.TargetId is { Length: > 0 } ? connection.TargetId : DefaultTargetId;
        var displayName = parsed is null
            ? RequireNonBlank(connection.DisplayName, connectionSection, nameof(LiveIncidentsConnectionOptions.DisplayName))
            : connection.DisplayName is { Length: > 0 } ? connection.DisplayName : DefaultDisplayName;

        var secretOptions = new SecretFileProviderOptions
        {
            SecretsDirectory = connection.Secrets.Directory,
            MaxSecretSizeBytes = connection.Secrets.MaxSecretSizeBytes,
        };

        services.AddKeyedSingleton<ISecretFileProvider>(
            ConnectionFactoryServiceKey,
            parsed?.InlineSecrets ?? new FileSecretFileProvider(secretOptions));
        services.AddKeyedSingleton<ISqlConnectionFactory>(
            ConnectionFactoryServiceKey,
            (sp, _) => new SqlConnectionFactory(
                sp.GetRequiredKeyedService<ISecretFileProvider>(ConnectionFactoryServiceKey)));
        services.AddSingleton<ILiveIncidentProbeExecutor>(sp =>
            new SqlLiveIncidentProbeExecutor(
                sp.GetRequiredKeyedService<ISqlConnectionFactory>(ConnectionFactoryServiceKey),
                profile,
                probeCatalog,
                platform,
                maxRequestRows: maxRequestRows,
                maxTextLength: maxTextLength,
                maxTempdbRows: maxTempdbRows));
        services.AddSingleton<ILiveIncidentCollector>(sp =>
            new LiveIncidentCollector(
                sp.GetRequiredService<ILiveIncidentProbeExecutor>(),
                targetId,
                displayName,
                configuredPlatform: platform));
    }

    /// <summary>
    /// Turns one configured sample bound into the probe parameter it becomes: a positive value caps,
    /// and <c>0</c> means "no cap" so an operator can deliberately restore the unbounded behaviour.
    /// A negative value is rejected rather than quietly treated as either, because "-1" is a
    /// plausible guess at "unlimited" and silently capping at nothing -- or at everything -- would
    /// misreport the instance in opposite directions.
    /// </summary>
    private static int? ParseBound(int value, string section, string key) => value switch
    {
        0 => null,
        > 0 => value,
        _ => throw new LiveIncidentsConfigurationException(
            $"{section}:{key} must be a positive row/character count, or 0 for no bound."),
    };

    private static ConnectionStringProfile ParseConnectionString(        string connectionString,
        LiveIncidentsConnectionOptions connection,
        string connectionSection)
    {
        try
        {
            return ConnectionStringProfile.Parse(
                connectionString,
                new ConnectionProfileId(
                    connection.TargetId is { Length: > 0 } targetId ? targetId : DefaultTargetId));
        }
        catch (ConnectionProfileValidationException ex)
        {
            // ConnectionProfileValidationException messages name fields and rules only,
            // never a configured value, so wrapping cannot disclose the password.
            throw new LiveIncidentsConfigurationException(
                $"{connectionSection}:{nameof(LiveIncidentsConnectionOptions.ConnectionString)}: {ex.Message}", ex);
        }
    }

    private static EnginePlatform ParsePlatform(string? rawPlatform, string connectionSection)
    {
        if (string.IsNullOrWhiteSpace(rawPlatform))
        {
            throw new LiveIncidentsConfigurationException(
                $"{connectionSection}:{nameof(LiveIncidentsConnectionOptions.Platform)} must be configured when LiveIncidents:Mode is Connected " +
                "(requirement 3: platform must never be inferred from a master-scoped identity probe).");
        }

        // Unknown/Unsupported are valid contract values but must never be *configured*: an
        // operator opting into Connected mode always knows and states the real platform.
        if (!Enum.TryParse<EnginePlatform>(rawPlatform, ignoreCase: true, out var platform)
            || platform is EnginePlatform.Unknown or EnginePlatform.Unsupported)
        {
            throw new LiveIncidentsConfigurationException(
                $"{connectionSection}:{nameof(LiveIncidentsConnectionOptions.Platform)} '{rawPlatform}' must be one of: " +
                $"{EnginePlatform.SqlServerOnPremises}, {EnginePlatform.AzureSqlDatabase}, {EnginePlatform.AzureSqlManagedInstance}.");
        }

        return platform;
    }

    private static ConnectionProfile BuildConnectionProfile(LiveIncidentsConnectionOptions connection, string connectionSection)
    {
        try
        {
            var server = new ServerAddress(
                RequireNonBlank(connection.Server.Host, connectionSection, $"{nameof(LiveIncidentsConnectionOptions.Server)}:{nameof(LiveIncidentsServerOptions.Host)}"),
                connection.Server.InstanceName,
                connection.Server.Port);

            var database = RequireNonBlank(connection.Database, connectionSection, nameof(LiveIncidentsConnectionOptions.Database));

            var timeouts = new ConnectionTimeouts(connection.Timeouts.ConnectSeconds, connection.Timeouts.CommandSeconds);
            var pool = new PoolBounds(connection.Pool.MinPoolSize, connection.Pool.MaxPoolSize);

            if (!Enum.TryParse<EncryptionPolicy>(connection.Encryption, ignoreCase: true, out var encryption))
            {
                throw new LiveIncidentsConfigurationException(
                    $"{connectionSection}:{nameof(LiveIncidentsConnectionOptions.Encryption)} '{connection.Encryption}' must be 'Mandatory' or 'Strict'.");
            }

            var authentication = BuildAuthenticationStrategy(connection.Authentication, connectionSection);

            return new ConnectionProfile(
                new ConnectionProfileId(RequireNonBlank(connection.TargetId, connectionSection, nameof(LiveIncidentsConnectionOptions.TargetId))),
                server,
                database,
                timeouts,
                pool,
                encryption,
                authentication,
                connection.HostNameInCertificate,
                connection.TrustServerCertificate);
        }
        catch (ConnectionProfileValidationException ex)
        {
            // ConnectionProfileValidationException messages are already secret-free (field names
            // and shapes only); wrapping preserves that guarantee while identifying the section.
            throw new LiveIncidentsConfigurationException($"{connectionSection}: {ex.Message}", ex);
        }
    }

    private static AuthenticationStrategy BuildAuthenticationStrategy(LiveIncidentsAuthenticationOptions auth, string connectionSection)
    {
        var authSection = $"{connectionSection}:{nameof(LiveIncidentsConnectionOptions.Authentication)}";
        var mode = RequireNonBlank(auth.Mode, connectionSection, $"{nameof(LiveIncidentsConnectionOptions.Authentication)}:{nameof(LiveIncidentsAuthenticationOptions.Mode)}");

        return mode.ToLowerInvariant() switch
        {
            "sqllogin" => new SqlLoginAuthenticationStrategy(
                RequireNonBlank(auth.Username, authSection, nameof(LiveIncidentsAuthenticationOptions.Username)),
                RequireNonBlank(auth.PasswordSecretFile, authSection, nameof(LiveIncidentsAuthenticationOptions.PasswordSecretFile))),
            "managedidentity" => new ManagedIdentityAuthenticationStrategy(auth.UserAssignedClientId),
            "workloadidentity" => new WorkloadIdentityAuthenticationStrategy(
                RequireNonBlank(auth.TenantId, authSection, nameof(LiveIncidentsAuthenticationOptions.TenantId)),
                RequireNonBlank(auth.ClientId, authSection, nameof(LiveIncidentsAuthenticationOptions.ClientId)),
                auth.FederatedTokenFilePath),
            "serviceprincipalcertificate" => new ServicePrincipalCertificateAuthenticationStrategy(
                RequireNonBlank(auth.TenantId, authSection, nameof(LiveIncidentsAuthenticationOptions.TenantId)),
                RequireNonBlank(auth.ClientId, authSection, nameof(LiveIncidentsAuthenticationOptions.ClientId)),
                RequireNonBlank(auth.CertificateSecretFile, authSection, nameof(LiveIncidentsAuthenticationOptions.CertificateSecretFile)),
                string.IsNullOrWhiteSpace(auth.CertificatePasswordSecretFile)
                    ? (SecretFileReference?)null
                    : new SecretFileReference(auth.CertificatePasswordSecretFile)),
            "serviceprincipalsecret" => new ServicePrincipalSecretAuthenticationStrategy(
                RequireNonBlank(auth.TenantId, authSection, nameof(LiveIncidentsAuthenticationOptions.TenantId)),
                RequireNonBlank(auth.ClientId, authSection, nameof(LiveIncidentsAuthenticationOptions.ClientId)),
                RequireNonBlank(auth.ClientSecretFile, authSection, nameof(LiveIncidentsAuthenticationOptions.ClientSecretFile))),
            "kerberos" => new KerberosAuthenticationStrategy(),
            _ => throw new LiveIncidentsConfigurationException(
                $"{authSection}:{nameof(LiveIncidentsAuthenticationOptions.Mode)} '{auth.Mode}' must be one of: " +
                "SqlLogin, Kerberos, ManagedIdentity, WorkloadIdentity, ServicePrincipalCertificate, ServicePrincipalSecret."),
        };
    }

    private static string RequireNonBlank(string? value, string section, string key)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new LiveIncidentsConfigurationException($"{section}:{key} must be configured when LiveIncidents:Mode is Connected.");
        }

        return value;
    }
}
