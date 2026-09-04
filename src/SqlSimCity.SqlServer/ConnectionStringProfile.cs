using System.Globalization;
using Microsoft.Data.SqlClient;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer;

/// <summary>
/// Translates one ordinary ADO.NET connection string into exactly the same
/// fully validated <see cref="ConnectionProfile"/> the field-by-field
/// configuration paths produce, so a single environment variable can stand in
/// for a server/database/timeout/pool/encryption/authentication profile plus a
/// mounted password file.
///
/// This is a convenience trade-off, and a deliberate one. A password supplied
/// inline lives in the process environment or configuration rather than a
/// mounted secret file: anything that can read the environment can read it, and
/// it cannot be rotated without a restart. What it does not do is weaken the
/// connection itself -- the parsed profile flows through the normal
/// <see cref="SqlConnectionFactory"/> path, which rebuilds the connection string
/// from the profile alone, still forces
/// <see cref="ConnectionProfile.ApplicationName"/> and a read-only application
/// intent, still requires TLS, and still passes the password as a
/// <c>SqlCredential</c> instead of embedding it in a connection string. See
/// SECURITY.md.
/// </summary>
public sealed class ConnectionStringProfile
{
    /// <summary>
    /// The synthetic secret name an inline password is resolved under. It is
    /// served by <see cref="InlineSecretProvider"/> and never touches the
    /// filesystem, so it can coexist with a real secrets directory.
    /// </summary>
    public const string InlinePasswordSecretName = "inline-connection-string-password";

    private const string DefaultInitialDatabase = "master";
    private const string AzureSqlHostSuffix = ".database.windows.net";

    // Matches the field-configured paths (Atlas and the edge connector both
    // default to 20) rather than SqlClient's default of 100. A connection string
    // that is silent about pooling must not quietly quadruple the number of
    // connections this tool can open against a server it is monitoring.
    private const int DefaultMaxPoolSize = 20;

    // The only network-library prefix whose semantics survive the rebuild:
    // ServerAddress.ToDataSource() re-emits "tcp:host,port". Every other prefix
    // selects a different endpoint or protocol and is rejected below rather than
    // stripped, since stripping would silently connect somewhere else.
    private const string TcpDataSourcePrefix = "tcp:";

    private static readonly string[] UnsupportedDataSourcePrefixes = ["np:", "lpc:", "admin:"];

    private ConnectionStringProfile(
        ConnectionProfile profile,
        ISecretFileProvider? inlineSecrets,
        bool isAzureSqlHost)
    {
        Profile = profile;
        InlineSecrets = inlineSecrets;
        IsAzureSqlHost = isAzureSqlHost;
    }

    /// <summary>The validated profile every collector and the connection factory consume.</summary>
    public ConnectionProfile Profile { get; }

    /// <summary>
    /// The provider that resolves an inline password, or <c>null</c> when the
    /// connection string carried no secret (Kerberos/SSPI or managed identity).
    /// Callers hand this to <see cref="SqlConnectionFactory"/> in place of a
    /// <see cref="FileSecretFileProvider"/>.
    /// </summary>
    public ISecretFileProvider? InlineSecrets { get; }

    /// <summary>
    /// Whether the parsed host is an Azure SQL endpoint. A connection string
    /// cannot state the engine platform, so callers that need one use this as a
    /// default only, and always let explicit configuration win.
    /// </summary>
    public bool IsAzureSqlHost { get; }

    /// <summary>Convenience access to the parsed initial/target database.</summary>
    public string InitialDatabase => Profile.InitialDatabase;

    public static ConnectionStringProfile Parse(string connectionString, ConnectionProfileId id)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(connectionString);

        SqlConnectionStringBuilder builder;
        try
        {
            builder = new SqlConnectionStringBuilder(connectionString);
        }
        catch (Exception ex) when (ex is ArgumentException or FormatException or KeyNotFoundException)
        {
            // Deliberately relays neither ex.Message nor ex as an inner exception.
            // SqlClient's parse failures are not uniformly value-free: a malformed
            // numeric keyword throws FormatException naming the offending value
            // ("The input string 'x' was not in a correct format"), and an
            // unquoted ';' or '=' inside a password splits it into fragments that
            // can resurface as "Keyword not supported: '<fragment>'". Since this
            // exception reaches logs and startup diagnostics, it carries a fixed,
            // curated message instead -- the same trade the rest of this library
            // makes for configuration errors.
            throw new ConnectionProfileValidationException(
                "The connection string could not be parsed. Common causes: an unquoted ';' or '=' inside " +
                "the password (wrap the whole value in single quotes, as in Password='p;a=ss'), a misspelled " +
                "keyword, or a non-numeric timeout or pool size. The underlying parser error is withheld " +
                "because it can quote the offending value.");
        }

        ServerAddress server;
        ConnectionProfile profile;
        ISecretFileProvider? inlineSecrets;
        try
        {
            server = ParseDataSource(builder.DataSource);
            AuthenticationStrategy authentication;
            (authentication, inlineSecrets) = ParseAuthentication(builder);

            profile = new ConnectionProfile(
                id,
                server,
                string.IsNullOrWhiteSpace(builder.InitialCatalog) ? DefaultInitialDatabase : builder.InitialCatalog.Trim(),
                ParseTimeouts(builder),
                ParsePoolBounds(builder),
                ParseEncryption(builder.Encrypt),
                authentication,
                string.IsNullOrWhiteSpace(builder.HostNameInCertificate) ? null : builder.HostNameInCertificate.Trim(),
                builder.TrustServerCertificate);
        }
        catch (AuthenticationConfigurationException ex)
        {
            // Normalized so every caller's `catch (ConnectionProfileValidationException)`
            // covers the whole parse. Left un-normalized, a non-GUID managed-identity
            // `User Id` would escape the curated configuration handlers and surface as
            // an unhandled startup fault with the wrong exit code. These messages name
            // fields and rules only, so relaying one cannot disclose a value.
            throw new ConnectionProfileValidationException(
                $"The connection string's authentication settings are invalid: {ex.Message}");
        }
        catch (ArgumentException ex)
        {
            // Same reason. ServerAddress uses ArgumentException for an empty host,
            // which a data source like 'np:\\host\pipe' can still reduce to.
            throw new ConnectionProfileValidationException(
                "The connection string's Server could not be resolved to a host name; " +
                "use 'Server=host,port' or 'Server=host\\instance'.", ex);
        }

        return new ConnectionStringProfile(profile, inlineSecrets, IsAzureSqlHostName(server.Host));
    }

    /// <summary>
    /// Honors an explicit <c>Max Pool Size</c> but substitutes SQLSimCity's own
    /// default when the connection string is silent, so a convenience string can
    /// never open more connections than the documented field configuration would.
    /// </summary>
    private static PoolBounds ParsePoolBounds(SqlConnectionStringBuilder builder) =>
        new(builder.MinPoolSize,
            builder.ShouldSerialize("Max Pool Size") ? builder.MaxPoolSize : DefaultMaxPoolSize);

    /// <summary>A routing hint only; Managed Instance shares this suffix and needs an explicit platform.</summary>
    public static bool IsAzureSqlHostName(string host) =>
        host.EndsWith(AzureSqlHostSuffix, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Splits SqlClient's <c>Data Source</c> syntax into the host, named
    /// instance, and port <see cref="ServerAddress"/> validates separately.
    /// </summary>
    private static ServerAddress ParseDataSource(string dataSource)
    {
        if (string.IsNullOrWhiteSpace(dataSource))
        {
            throw new ConnectionProfileValidationException(
                "The connection string must set Server (Data Source), for example 'Server=localhost,1433'.");
        }

        var remaining = dataSource.Trim();
        foreach (var prefix in UnsupportedDataSourcePrefixes)
        {
            if (remaining.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new ConnectionProfileValidationException(
                    $"The connection string's Server uses the '{prefix}' network library prefix, which SQLSimCity " +
                    "does not support: it selects a different endpoint or protocol than the TCP connection this " +
                    "tool rebuilds, so honoring it silently is not possible. Use 'Server=host,port' or " +
                    "'Server=host\\instance'.");
            }
        }

        if (remaining.StartsWith(TcpDataSourcePrefix, StringComparison.OrdinalIgnoreCase))
        {
            remaining = remaining[TcpDataSourcePrefix.Length..].Trim();
        }

        int? port = null;
        var portSeparator = remaining.LastIndexOf(',');
        if (portSeparator >= 0)
        {
            var portText = remaining[(portSeparator + 1)..].Trim();
            if (!int.TryParse(portText, NumberStyles.None, CultureInfo.InvariantCulture, out var parsedPort))
            {
                throw new ConnectionProfileValidationException(
                    "The connection string's Server port must be a plain number, as in 'Server=localhost,1433'.");
            }

            port = parsedPort;
            remaining = remaining[..portSeparator].Trim();
        }

        string? instanceName = null;
        var instanceSeparator = remaining.IndexOf('\\', StringComparison.Ordinal);
        if (instanceSeparator >= 0)
        {
            instanceName = remaining[(instanceSeparator + 1)..].Trim();
            remaining = remaining[..instanceSeparator].Trim();
            if (instanceName.Length == 0)
            {
                instanceName = null;
            }
        }

        if (instanceName is not null && port is not null)
        {
            throw new ConnectionProfileValidationException(
                "The connection string's Server names both a named instance and a port; configure exactly one " +
                "(for example 'Server=host\\SQLEXPRESS' or 'Server=host,1433').");
        }

        return new ServerAddress(remaining, instanceName, port);
    }

    private static EncryptionPolicy ParseEncryption(SqlConnectionEncryptOption encrypt)
    {
        if (SqlConnectionEncryptOption.Strict.Equals(encrypt))
        {
            return EncryptionPolicy.Strict;
        }

        if (SqlConnectionEncryptOption.Mandatory.Equals(encrypt))
        {
            return EncryptionPolicy.Mandatory;
        }

        throw new ConnectionProfileValidationException(
            "Encrypt=false is not supported; every profile requires TLS. Use Encrypt=true (the default) or " +
            "Encrypt=strict, and add TrustServerCertificate=true when the target presents a self-signed " +
            "development certificate.");
    }

    private static ConnectionTimeouts ParseTimeouts(SqlConnectionStringBuilder builder)
    {
        if (builder.ConnectTimeout == 0)
        {
            throw new ConnectionProfileValidationException(
                "Connect Timeout=0 (infinite) is not supported; use " +
                $"{ConnectionTimeouts.MinConnectSeconds}-{ConnectionTimeouts.MaxConnectSeconds} seconds.");
        }

        if (builder.CommandTimeout == 0)
        {
            throw new ConnectionProfileValidationException(
                "Command Timeout=0 (infinite) is not supported; use " +
                $"{ConnectionTimeouts.MinCommandSeconds}-{ConnectionTimeouts.MaxCommandSeconds} seconds.");
        }

        return new ConnectionTimeouts(builder.ConnectTimeout, builder.CommandTimeout);
    }

    /// <summary>
    /// Maps the connection string's authentication keywords onto exactly one
    /// <see cref="AuthenticationStrategy"/>. Only the strategies a connection
    /// string can fully describe are accepted; the Entra strategies that also
    /// need a tenant id and a mounted certificate or client secret stay on the
    /// explicit configuration path rather than being half-configured here.
    /// </summary>
    private static (AuthenticationStrategy Authentication, ISecretFileProvider? InlineSecrets) ParseAuthentication(
        SqlConnectionStringBuilder builder)
    {
        var userId = string.IsNullOrWhiteSpace(builder.UserID) ? null : builder.UserID.Trim();

        if (builder.Authentication == SqlAuthenticationMethod.NotSpecified && builder.IntegratedSecurity)
        {
            return (new KerberosAuthenticationStrategy(), null);
        }

        switch (builder.Authentication)
        {
            case SqlAuthenticationMethod.NotSpecified:
            case SqlAuthenticationMethod.SqlPassword:
                if (userId is null)
                {
                    throw new ConnectionProfileValidationException(
                        "The connection string must select an authentication method: set User ID and Password for a " +
                        "SQL login, Integrated Security=true for Kerberos/SSPI, or " +
                        "Authentication='Active Directory Managed Identity'.");
                }

                if (string.IsNullOrEmpty(builder.Password))
                {
                    throw new ConnectionProfileValidationException(
                        "The connection string sets User ID but no Password.");
                }

                return (
                    new SqlLoginAuthenticationStrategy(userId, new SecretFileReference(InlinePasswordSecretName)),
                    new InlineSecretProvider(new SecretFileReference(InlinePasswordSecretName), builder.Password));

            case SqlAuthenticationMethod.ActiveDirectoryManagedIdentity:
                return (new ManagedIdentityAuthenticationStrategy(userId), null);

            default:
                throw new ConnectionProfileValidationException(
                    $"Authentication='{builder.Authentication}' cannot be configured by connection string alone. " +
                    "Connection strings support a SQL login (User ID and Password), Integrated Security=true " +
                    "(Kerberos/SSPI), and 'Active Directory Managed Identity'. Every other Entra strategy needs a " +
                    "tenant id, a client id, and a mounted certificate or client secret, so configure it field by " +
                    "field instead.");
        }
    }
}
