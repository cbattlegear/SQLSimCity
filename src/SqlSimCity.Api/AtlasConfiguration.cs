using SqlSimCity.Collection.Atlas;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Api;

public static class AtlasConfiguration
{
    /// <summary>The section-scoped connection string key, which wins over the shared ones.</summary>
    public const string ConnectionStringKey = "Atlas:ConnectionString";

    /// <summary>
    /// Connected when <c>Atlas:Mode</c> says so, or when a connection string is
    /// configured -- supplying one is itself an explicit statement that a real
    /// target exists, so it does not also have to be paired with a mode.
    /// </summary>
    public static bool IsConnected(IConfiguration configuration) =>
        configuration.GetValue<string>("Atlas:Mode")?.Equals("Connected", StringComparison.OrdinalIgnoreCase) == true
        || ResolveConnectionString(configuration) is not null;

    public static string? ResolveConnectionString(IConfiguration configuration) =>
        SqlSimCityConnectionString.Resolve(configuration, ConnectionStringKey);

    /// <summary>
    /// The <c>Atlas:Connection</c> keys a connection string already supplies.
    /// Configuring both is rejected rather than silently resolved. <c>ProfileId</c>
    /// is absent on purpose: it is only a label, so it stays usable alongside one.
    /// </summary>
    private static readonly string[] ConnectionStringProfileKeys =
    [
        "Host", "Instance", "Port", "InitialDatabase",
        "ConnectTimeoutSeconds", "CommandTimeoutSeconds", "MaxPoolSize",
        "Encryption", "HostNameInCertificate", "TrustServerCertificate",
        "Authentication",
    ];

    /// <summary>
    /// Parses the configured connection string once, or returns <c>null</c> when
    /// the field-by-field <c>Atlas:Connection</c> path is in use. Callers that
    /// need it more than once pass the result back in rather than reparsing, so
    /// an inline password is materialized as few times as possible.
    /// </summary>
    public static ConnectionStringProfile? TryParseConnectionString(IConfiguration configuration)
    {
        if (ResolveConnectionString(configuration) is not { } connectionString)
        {
            return null;
        }

        SqlSimCityConnectionString.EnsureNoFieldConflict(
            configuration, "Atlas:Connection", ConnectionStringProfileKeys,
            message => new InvalidOperationException(message));

        return ConnectionStringProfile.Parse(connectionString, BuildProfileId(configuration));
    }

    public static AtlasCollectionOptions BuildCollectionOptions(
        IConfiguration configuration,
        ConnectionStringProfile? parsedConnectionString = null)
    {
        var section = configuration.GetSection("Atlas");
        var configuredDatabases = section.GetSection("KnownDatabases").Get<string[]>() ?? [];
        var parsed = parsedConnectionString ?? TryParseConnectionString(configuration);

        // Azure SQL Database enumerates only the connected database, so a
        // connection-string-only setup that named none falls back to the single
        // database the connection string already identifies. On-premises and
        // Managed Instance targets enumerate for themselves and need no default.
        var knownDatabases = configuredDatabases.Length == 0 && parsed is { IsAzureSqlHost: true }
            ? new[] { parsed.InitialDatabase }
            : configuredDatabases;

        var refreshInterval = TimeSpan.FromSeconds(section.GetValue<int?>("RefreshIntervalSeconds") ?? 60);
        var options = new AtlasCollectionOptions
        {
            TargetId = section.GetValue<string>("TargetId") ?? "primary",
            DisplayName = section.GetValue<string>("DisplayName") ?? "SQL Server",
            KnownDatabases = knownDatabases,
            DatabaseConcurrency = section.GetValue<int?>("DatabaseConcurrency") ?? 4,
            QueryStoreWindow = TimeSpan.FromMinutes(section.GetValue<int?>("QueryStoreWindowMinutes") ?? 1_440),
            RefreshInterval = refreshInterval,

            // A cadence cannot be faster than the cycle that schedules it, so an atlas already
            // configured to refresh more slowly than the default keeps its own interval rather
            // than being refused at startup over a setting it never asked for.
            QueryStoreRefreshInterval = section.GetValue<int?>("QueryStoreRefreshIntervalSeconds") is { } seconds
                ? TimeSpan.FromSeconds(seconds)
                : Max(TimeSpan.FromSeconds(900), refreshInterval),
            StaleAfter = TimeSpan.FromSeconds(section.GetValue<int?>("StaleAfterSeconds") ?? 180),
        };
        options.Validate();
        return options;
    }

    private static TimeSpan Max(TimeSpan left, TimeSpan right) => left > right ? left : right;

    public static ConnectionProfile BuildProfile(
        IConfiguration configuration,
        ConnectionStringProfile? parsedConnectionString = null)
    {
        if ((parsedConnectionString ?? TryParseConnectionString(configuration)) is { } parsed)
        {
            return parsed.Profile;
        }

        var section = configuration.GetRequiredSection("Atlas:Connection");
        var authentication = BuildAuthentication(section.GetRequiredSection("Authentication"));
        return new ConnectionProfile(
            new ConnectionProfileId(section.GetValue<string>("ProfileId") ?? "atlas-primary"),
            new ServerAddress(
                section.GetValue<string>("Host") ?? throw new InvalidOperationException("Atlas:Connection:Host is required."),
                section.GetValue<string>("Instance"),
                section.GetValue<int?>("Port")),
            section.GetValue<string>("InitialDatabase") ?? "master",
            new ConnectionTimeouts(
                section.GetValue<int?>("ConnectTimeoutSeconds") ?? 15,
                section.GetValue<int?>("CommandTimeoutSeconds") ?? 30),
            new PoolBounds(0, section.GetValue<int?>("MaxPoolSize") ?? 20),
            Enum.Parse<EncryptionPolicy>(section.GetValue<string>("Encryption") ?? "Mandatory", ignoreCase: true),
            authentication,
            section.GetValue<string>("HostNameInCertificate"),
            section.GetValue<bool?>("TrustServerCertificate") ?? false);
    }

    /// <summary>
    /// The secret provider the Atlas connection factory uses: an in-memory one
    /// carrying the connection string's own password when there is one, and the
    /// mounted secrets directory otherwise.
    /// </summary>
    public static ISecretFileProvider BuildSecretProvider(
        IConfiguration configuration,
        ConnectionStringProfile? parsedConnectionString = null) =>
        (parsedConnectionString ?? TryParseConnectionString(configuration))?.InlineSecrets
        ?? new FileSecretFileProvider(BuildSecretOptions(configuration));

    public static SecretFileProviderOptions BuildSecretOptions(IConfiguration configuration) => new()
    {
        SecretsDirectory = configuration.GetValue<string>("Atlas:SecretsDirectory")
            ?? SecretFileProviderOptions.DefaultSecretsDirectory,
    };

    private static ConnectionProfileId BuildProfileId(IConfiguration configuration) =>
        new(configuration.GetValue<string>("Atlas:Connection:ProfileId") ?? "atlas-primary");

    private static AuthenticationStrategy BuildAuthentication(IConfiguration section)
    {
        var mode = section.GetValue<string>("Mode") ?? throw new InvalidOperationException("Atlas connection authentication mode is required.");
        return mode.ToUpperInvariant() switch
        {
            "SQLLOGIN" => new SqlLoginAuthenticationStrategy(
                section.GetValue<string>("Username") ?? throw new InvalidOperationException("SQL login username is required."),
                new SecretFileReference(section.GetValue<string>("PasswordSecret")
                    ?? throw new InvalidOperationException("SQL login password secret reference is required."))),
            "KERBEROS" => new KerberosAuthenticationStrategy(),
            "MANAGEDIDENTITY" => new ManagedIdentityAuthenticationStrategy(section.GetValue<string>("UserAssignedClientId")),
            "WORKLOADIDENTITY" => new WorkloadIdentityAuthenticationStrategy(
                Required(section, "TenantId"), Required(section, "ClientId"), section.GetValue<string>("FederatedTokenFilePath")),
            "SERVICEPRINCIPALSECRET" => new ServicePrincipalSecretAuthenticationStrategy(
                Required(section, "TenantId"), Required(section, "ClientId"),
                new SecretFileReference(Required(section, "ClientSecret"))),
            "SERVICEPRINCIPALCERTIFICATE" => new ServicePrincipalCertificateAuthenticationStrategy(
                Required(section, "TenantId"), Required(section, "ClientId"),
                new SecretFileReference(Required(section, "CertificateSecret")),
                section.GetValue<string>("CertificatePasswordSecret") is { } password
                    ? new SecretFileReference(password)
                    : (SecretFileReference?)null),
            _ => throw new InvalidOperationException("Atlas connection authentication mode is not supported."),
        };
    }

    private static string Required(IConfiguration configuration, string name) =>
        configuration.GetValue<string>(name) ?? throw new InvalidOperationException($"Atlas authentication {name} is required.");
}
