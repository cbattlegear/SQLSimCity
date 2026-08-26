using System.Globalization;
using SqlSimCity.Collection.Atlas;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Edge.Connector;

public enum ConnectorSourceMode { Fixture, Connected }

public sealed record ConnectedSourceOptions(
    ConnectionProfile Profile,
    EnginePlatform Platform,
    string TargetDisplayName,
    IReadOnlyList<string> KnownDatabases,
    SecretFileProviderOptions SecretFiles,
    AtlasCollectionOptions Atlas,
    QueryStoreCollectionOptions QueryStore)
{
    /// <summary>
    /// Set only when the profile came from <c>SQLSIMCITY_EDGE_SQL_CONNECTION_STRING</c>
    /// and that connection string carried a password. It resolves that one secret
    /// from memory instead of <see cref="SecretFiles"/>; see
    /// <see cref="ConnectionStringProfile"/> for what an inline password gives up.
    /// </summary>
    public ISecretFileProvider? InlineSecrets { get; init; }
}

/// <summary>
/// Immutable, validated connector configuration. Values come from prefixed environment variables;
/// secrets are never configuration values — only file references are configured, and the
/// bytes are read from those files at use time. HTTP is refused unless the endpoint is an explicit
/// loopback development address.
/// </summary>
public sealed record ConnectorOptions
{
    public required string ConnectorId { get; init; }
    public required string TargetId { get; init; }
    public required string KeyId { get; init; }
    public required Uri IngestEndpoint { get; init; }
    public ConnectorSourceMode SourceMode { get; init; } = ConnectorSourceMode.Fixture;
    public ConnectedSourceOptions? Connected { get; init; }

    /// <summary>Path to the per-connector HMAC secret (base64, at least 32 bytes) file or Docker secret.</summary>
    public required string SigningSecretFile { get; init; }

    /// <summary>Directory holding the encrypted spool.</summary>
    public required string SpoolDirectory { get; init; }

    /// <summary>Path to the spool AES-256 key file (separate from the signing secret).</summary>
    public required string SpoolKeyFile { get; init; }

    /// <summary>Directory containing the validated V1 fixtures the connector packages as observations.</summary>
    public required string FixturesDirectory { get; init; }

    public TimeSpan CollectInterval { get; init; } = TimeSpan.FromSeconds(15);
    public TimeSpan DeliverInterval { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Ceiling on the collection cadence after consecutive spool backpressure rejections. During an
    /// outage the collection cycle decays exponentially from <see cref="CollectInterval"/> up to this
    /// bound instead of querying, serializing, and sealing a batch every cycle only to have it
    /// rejected. A ceiling below <see cref="CollectInterval"/> simply means no backoff.
    /// </summary>
    public TimeSpan CollectBackoffMaxInterval { get; init; } = TimeSpan.FromMinutes(5);

    public bool AllowLoopbackHttp { get; init; }

    /// <summary>Optional loopback-only health port. 0 disables it. Never a control API.</summary>
    public int LoopbackHealthPort { get; init; }

    public long SpoolMaxBytes { get; init; } = 64L * 1024 * 1024;
    public int SpoolMaxItems { get; init; } = 4096;
    public TimeSpan SpoolMaxAge { get; init; } = TimeSpan.FromHours(24);

    public void Validate()
    {
        RequireNonEmpty(ConnectorId, nameof(ConnectorId));
        RequireNonEmpty(TargetId, nameof(TargetId));
        RequireNonEmpty(KeyId, nameof(KeyId));
        RequireNonEmpty(SigningSecretFile, nameof(SigningSecretFile));
        RequireNonEmpty(SpoolDirectory, nameof(SpoolDirectory));
        RequireNonEmpty(SpoolKeyFile, nameof(SpoolKeyFile));
        if (SourceMode == ConnectorSourceMode.Fixture)
            RequireNonEmpty(FixturesDirectory, nameof(FixturesDirectory));
        if (SourceMode == ConnectorSourceMode.Connected && Connected is null)
            throw new ConnectorConfigurationException("Connected source options must be configured.");
        ArgumentNullException.ThrowIfNull(IngestEndpoint);
        if (!IngestEndpoint.IsAbsoluteUri)
            throw new ConnectorConfigurationException("SQLSIMCITY_EDGE_INGEST_ENDPOINT must be an absolute URI.");
        if (CollectInterval < TimeSpan.FromSeconds(1) || CollectInterval > TimeSpan.FromHours(1))
            throw new ConnectorConfigurationException("Collect interval must be between 1 second and 1 hour.");
        if (DeliverInterval < TimeSpan.FromSeconds(1) || DeliverInterval > TimeSpan.FromHours(1))
            throw new ConnectorConfigurationException("Deliver interval must be between 1 second and 1 hour.");
        if (CollectBackoffMaxInterval < TimeSpan.Zero || CollectBackoffMaxInterval > TimeSpan.FromHours(24))
            throw new ConnectorConfigurationException("Collect backoff ceiling must be between 0 seconds and 24 hours.");
        if (LoopbackHealthPort is < 0 or > 65535)
            throw new ConnectorConfigurationException("Loopback health port must be between 0 and 65535.");
    }

    /// <summary>Reads options from environment variables prefixed <c>SQLSIMCITY_EDGE_</c>.</summary>
    public static ConnectorOptions FromEnvironment(IReadOnlyDictionary<string, string?> env)
    {
        ArgumentNullException.ThrowIfNull(env);
        string? Get(string key) => env.TryGetValue("SQLSIMCITY_EDGE_" + key, out var value) ? value : null;
        var sourceMode = ParseSourceMode(Get("SOURCE_MODE"));

        ConnectorOptions options;
        try
        {
            var targetId = Get("TARGET_ID") ?? throw Missing("TARGET_ID");
            options = new ConnectorOptions
            {
                ConnectorId = Get("CONNECTOR_ID") ?? throw Missing("CONNECTOR_ID"),
                TargetId = targetId,
                KeyId = Get("KEY_ID") ?? throw Missing("KEY_ID"),
                IngestEndpoint = new Uri(Get("INGEST_ENDPOINT") ?? throw Missing("INGEST_ENDPOINT"), UriKind.Absolute),
                SourceMode = sourceMode,
                Connected = sourceMode == ConnectorSourceMode.Connected
                    ? BuildConnected(env, targetId)
                    : null,
                SigningSecretFile = Get("SIGNING_SECRET_FILE") ?? throw Missing("SIGNING_SECRET_FILE"),
                SpoolDirectory = Get("SPOOL_DIR") ?? throw Missing("SPOOL_DIR"),
                SpoolKeyFile = Get("SPOOL_KEY_FILE") ?? throw Missing("SPOOL_KEY_FILE"),
                FixturesDirectory = Get("FIXTURES_DIR") ?? string.Empty,
                CollectInterval = ParseSeconds(Get("COLLECT_INTERVAL_SECONDS"), 15),
                DeliverInterval = ParseSeconds(Get("DELIVER_INTERVAL_SECONDS"), 5),
                CollectBackoffMaxInterval = ParseSeconds(Get("COLLECT_MAX_BACKOFF_SECONDS"), 300),
                AllowLoopbackHttp = ParseBool(Get("ALLOW_LOOPBACK_HTTP")),
                LoopbackHealthPort = ParseInt(Get("LOOPBACK_HEALTH_PORT"), 0),
                SpoolMaxBytes = ParseLong(Get("SPOOL_MAX_BYTES"), 64L * 1024 * 1024),
                SpoolMaxItems = ParseInt(Get("SPOOL_MAX_ITEMS"), 4096),
                SpoolMaxAge = ParseSeconds(Get("SPOOL_MAX_AGE_SECONDS"), 24 * 3600),
            };
        }
        catch (ConnectorConfigurationException)
        {
            throw;
        }
        catch (Exception ex) when (
            ex is ArgumentException or FormatException or
            ConnectionProfileValidationException or SecretResolutionException)
        {
            throw new ConnectorConfigurationException(
                "Connected SQL source configuration is invalid; check the documented field shapes.");
        }

        options.Validate();
        return options;
    }

    /// <summary>
    /// Profile fields a connection string already carries. Setting one alongside
    /// <c>SQLSIMCITY_EDGE_SQL_CONNECTION_STRING</c> is rejected rather than
    /// silently ignored, so an operator can never edit a value that has no effect.
    /// </summary>
    private static readonly string[] ConnectionStringProfileKeys =
    [
        "HOST", "INSTANCE", "PORT", "INITIAL_DATABASE", "AUTH_MODE", "USERNAME",
        "PASSWORD_SECRET_FILE", "ENCRYPTION", "TRUST_SERVER_CERTIFICATE",
        "HOST_NAME_IN_CERTIFICATE", "CONNECT_TIMEOUT_SECONDS", "COMMAND_TIMEOUT_SECONDS",
        "MIN_POOL_SIZE", "MAX_POOL_SIZE",
        // Authentication identity fields. USER_ASSIGNED_CLIENT_ID especially: a
        // connection string expresses it as the managed-identity `User Id`, so
        // leaving it out here would let an operator set it, see no error, and
        // silently authenticate as the system-assigned identity instead. The
        // rest are inert once AUTH_MODE is rejected, but are listed so the
        // "never edit a value that has no effect" rule holds uniformly.
        "USER_ASSIGNED_CLIENT_ID", "TENANT_ID", "CLIENT_ID", "FEDERATED_TOKEN_FILE",
        "CLIENT_SECRET_FILE", "CERTIFICATE_SECRET_FILE", "CERTIFICATE_PASSWORD_SECRET_FILE",
    ];

    private static ConnectedSourceOptions BuildConnected(
        IReadOnlyDictionary<string, string?> env,
        string targetId)
    {
        string? Get(string key) => env.TryGetValue("SQLSIMCITY_EDGE_SQL_" + key, out var value) ? value : null;
        foreach (var plaintext in new[] { "PASSWORD", "CLIENT_SECRET", "CERTIFICATE_PASSWORD", "FEDERATED_TOKEN" })
        {
            if (!string.IsNullOrEmpty(Get(plaintext)))
                throw new ConnectorConfigurationException(
                    $"SQLSIMCITY_EDGE_SQL_{plaintext} is a prohibited plaintext secret; configure its file reference instead.");
        }

        var secretsDirectory = Get("SECRETS_DIR") ?? SecretFileProviderOptions.DefaultSecretsDirectory;
        var maxSecretSize = ParseIntStrict(
            Get("MAX_SECRET_SIZE_BYTES"),
            SecretFileProviderOptions.DefaultMaxSecretSizeBytes,
            "SQL_MAX_SECRET_SIZE_BYTES");
        if (maxSecretSize <= 0)
            throw new ConnectorConfigurationException(
                "SQLSIMCITY_EDGE_SQL_MAX_SECRET_SIZE_BYTES must be positive.");
        var secretOptions = new SecretFileProviderOptions
        {
            SecretsDirectory = secretsDirectory,
            MaxSecretSizeBytes = maxSecretSize,
        };

        var parsedConnectionString = ParseConnectionString(Get, targetId);

        // A connection string cannot state the platform, so an Azure SQL endpoint
        // is assumed to be Azure SQL Database. Managed Instance shares that host
        // suffix and must always be stated explicitly.
        var rawPlatform = Get("PLATFORM");
        var platform = rawPlatform is null && parsedConnectionString is { } inferred
            ? (inferred.IsAzureSqlHost ? EnginePlatform.AzureSqlDatabase : EnginePlatform.SqlServerOnPremises)
            : ParseRequiredEnum<EnginePlatform>(rawPlatform, "SQL_PLATFORM");
        if (platform is EnginePlatform.Unknown or EnginePlatform.Unsupported)
            throw new ConnectorConfigurationException("SQLSIMCITY_EDGE_SQL_PLATFORM must identify a supported configured platform.");

        var knownDatabases = ParseList(Get("KNOWN_DATABASES"));
        if (knownDatabases.Length == 0 && platform == EnginePlatform.AzureSqlDatabase && parsedConnectionString is { } azure)
        {
            // Azure SQL Database enumerates only the connected database, so fall
            // back to the single database the connection string already names.
            knownDatabases = [azure.InitialDatabase];
        }

        if (platform == EnginePlatform.AzureSqlDatabase && knownDatabases.Length == 0)
            throw new ConnectorConfigurationException("Azure SQL Database requires at least one configured known database.");
        if (knownDatabases.Length > AtlasCollectionOptions.MaximumDatabases)
            throw new ConnectorConfigurationException("Known database count exceeds the bounded maximum of 100.");

        var profile = parsedConnectionString?.Profile ?? BuildFieldConfiguredProfile(Get, targetId, secretsDirectory);

        var displayName = Get("TARGET_DISPLAY_NAME") ?? (parsedConnectionString is null
            ? throw new ConnectorConfigurationException("SQLSIMCITY_EDGE_SQL_TARGET_DISPLAY_NAME is required.")
            : targetId);
        var atlas = new AtlasCollectionOptions
        {
            TargetId = targetId,
            DisplayName = displayName,
            KnownDatabases = knownDatabases,
            DatabaseConcurrency = ParseIntStrict(Get("DATABASE_CONCURRENCY"), 4, "SQL_DATABASE_CONCURRENCY"),
            QueryStoreWindow = TimeSpan.FromMinutes(
                ParseIntStrict(Get("QUERY_STORE_WINDOW_MINUTES"), 1_440, "SQL_QUERY_STORE_WINDOW_MINUTES")),
            RefreshInterval = TimeSpan.FromSeconds(10),
            StaleAfter = TimeSpan.FromSeconds(
                ParseIntStrict(Get("STALE_AFTER_SECONDS"), 180, "SQL_STALE_AFTER_SECONDS")),
        };
        atlas.Validate();
        var queryStore = new QueryStoreCollectionOptions(
            ParseIntStrict(Get("QUERY_STORE_PAGE_SIZE"), 1_000, "SQL_QUERY_STORE_PAGE_SIZE"),
            ParseIntStrict(Get("DATABASE_CONCURRENCY"), 4, "SQL_DATABASE_CONCURRENCY"),
            TimeSpan.FromMinutes(ParseIntStrict(
                Get("QUERY_STORE_OVERLAP_MINUTES"), 65, "SQL_QUERY_STORE_OVERLAP_MINUTES")));
        queryStore.Validate();
        return new ConnectedSourceOptions(
            profile, platform, displayName, knownDatabases, secretOptions, atlas, queryStore)
        {
            InlineSecrets = parsedConnectionString?.InlineSecrets,
        };
    }

    /// <summary>
    /// Parses <c>SQLSIMCITY_EDGE_SQL_CONNECTION_STRING</c> when it is set. This is
    /// the one deliberate exception to the connector's "no secret ever comes from
    /// an environment variable" rule: it exists so a basic connection needs one
    /// variable instead of a dozen plus a mounted file. The password still never
    /// reaches a connection string, a log, or a diagnostic -- see
    /// <see cref="ConnectionStringProfile"/> -- but it is readable by anything
    /// that can read this process's environment and cannot be rotated without a
    /// restart, so mounted secret files remain the deployment default.
    /// </summary>
    private static ConnectionStringProfile? ParseConnectionString(Func<string, string?> get, string targetId)
    {
        var connectionString = get("CONNECTION_STRING");
        if (string.IsNullOrWhiteSpace(connectionString))
            return null;

        foreach (var key in ConnectionStringProfileKeys)
        {
            if (!string.IsNullOrEmpty(get(key)))
                throw new ConnectorConfigurationException(
                    $"SQLSIMCITY_EDGE_SQL_{key} cannot be combined with SQLSIMCITY_EDGE_SQL_CONNECTION_STRING; " +
                    "configure the connection string alone, or remove it and configure every field explicitly.");
        }

        try
        {
            return ConnectionStringProfile.Parse(
                connectionString.Trim(), new ConnectionProfileId($"edge:{targetId}"));
        }
        catch (ConnectionProfileValidationException ex)
        {
            // These messages name keywords and rules only, never a configured
            // value, so relaying one cannot disclose the password.
            throw new ConnectorConfigurationException(
                $"SQLSIMCITY_EDGE_SQL_CONNECTION_STRING is invalid: {ex.Message}");
        }
    }

    private static ConnectionProfile BuildFieldConfiguredProfile(
        Func<string, string?> get,
        string targetId,
        string secretsDirectory)
    {
        var initialDatabase = get("INITIAL_DATABASE") ??
            throw new ConnectorConfigurationException("SQLSIMCITY_EDGE_SQL_INITIAL_DATABASE is required.");
        var authentication = BuildAuthentication(get, secretsDirectory);
        return new ConnectionProfile(
            new ConnectionProfileId($"edge:{targetId}"),
            new ServerAddress(
                get("HOST") ?? throw new ConnectorConfigurationException("SQLSIMCITY_EDGE_SQL_HOST is required."),
                get("INSTANCE"),
                ParseNullableInt(get("PORT"), "SQL_PORT")),
            initialDatabase,
            new ConnectionTimeouts(
                ParseIntStrict(get("CONNECT_TIMEOUT_SECONDS"), 15, "SQL_CONNECT_TIMEOUT_SECONDS"),
                ParseIntStrict(get("COMMAND_TIMEOUT_SECONDS"), 30, "SQL_COMMAND_TIMEOUT_SECONDS")),
            new PoolBounds(
                ParseIntStrict(get("MIN_POOL_SIZE"), 0, "SQL_MIN_POOL_SIZE"),
                ParseIntStrict(get("MAX_POOL_SIZE"), 20, "SQL_MAX_POOL_SIZE")),
            ParseRequiredEnum<EncryptionPolicy>(get("ENCRYPTION") ?? "Mandatory", "SQL_ENCRYPTION"),
            authentication,
            get("HOST_NAME_IN_CERTIFICATE"),
            ParseBoolStrict(get("TRUST_SERVER_CERTIFICATE"), false, "SQL_TRUST_SERVER_CERTIFICATE"));
    }

    private static AuthenticationStrategy BuildAuthentication(
        Func<string, string?> get,
        string secretsDirectory)
    {
        var mode = get("AUTH_MODE") ??
            throw new ConnectorConfigurationException("SQLSIMCITY_EDGE_SQL_AUTH_MODE is required.");
        string Required(string name) => get(name) ??
            throw new ConnectorConfigurationException($"SQLSIMCITY_EDGE_SQL_{name} is required for the configured authentication mode.");
        SecretFileReference Secret(string name) => new(Required(name));
        return mode.ToUpperInvariant() switch
        {
            "SQLLOGIN" => new SqlLoginAuthenticationStrategy(Required("USERNAME"), Secret("PASSWORD_SECRET_FILE")),
            "KERBEROS" => new KerberosAuthenticationStrategy(),
            "MANAGEDIDENTITY" => new ManagedIdentityAuthenticationStrategy(get("USER_ASSIGNED_CLIENT_ID")),
            "WORKLOADIDENTITY" => new WorkloadIdentityAuthenticationStrategy(
                Required("TENANT_ID"),
                Required("CLIENT_ID"),
                Path.Combine(secretsDirectory, Secret("FEDERATED_TOKEN_FILE").FileName)),
            "SERVICEPRINCIPALCERTIFICATE" => new ServicePrincipalCertificateAuthenticationStrategy(
                Required("TENANT_ID"),
                Required("CLIENT_ID"),
                Secret("CERTIFICATE_SECRET_FILE"),
                get("CERTIFICATE_PASSWORD_SECRET_FILE") is { Length: > 0 } password
                    ? new SecretFileReference(password)
                    : (SecretFileReference?)null),
            "SERVICEPRINCIPALSECRET" => new ServicePrincipalSecretAuthenticationStrategy(
                Required("TENANT_ID"), Required("CLIENT_ID"), Secret("CLIENT_SECRET_FILE")),
            _ => throw new ConnectorConfigurationException(
                "SQLSIMCITY_EDGE_SQL_AUTH_MODE must be one of: SqlLogin, Kerberos, ManagedIdentity, WorkloadIdentity, ServicePrincipalCertificate, ServicePrincipalSecret."),
        };
    }

    private static ConnectorSourceMode ParseSourceMode(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return ConnectorSourceMode.Fixture;
        if (Enum.TryParse<ConnectorSourceMode>(value, true, out var parsed))
            return parsed;
        throw new ConnectorConfigurationException(
            "SQLSIMCITY_EDGE_SOURCE_MODE must be Fixture or Connected.");
    }

    private static string[] ParseList(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return [];
        var values = value.Split(
            ',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (values.Distinct(StringComparer.OrdinalIgnoreCase).Count() != values.Length)
            throw new ConnectorConfigurationException(
                "SQLSIMCITY_EDGE_SQL_KNOWN_DATABASES must not contain duplicates.");
        return values;
    }

    private static T ParseRequiredEnum<T>(string? value, string key, T? fallback = null)
        where T : struct, Enum
    {
        if (value is null && fallback is { } fallbackValue)
            return fallbackValue;
        if (value is not null && Enum.TryParse<T>(value, true, out var parsed) && Enum.IsDefined(parsed))
            return parsed;
        throw new ConnectorConfigurationException($"SQLSIMCITY_EDGE_{key} is missing or invalid.");
    }

    private static int? ParseNullableInt(string? value, string key)
    {
        if (value is null)
            return null;
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : throw new ConnectorConfigurationException($"SQLSIMCITY_EDGE_{key} must be an integer.");
    }

    private static int ParseIntStrict(string? value, int fallback, string key)
    {
        if (value is null)
            return fallback;
        return int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : throw new ConnectorConfigurationException($"SQLSIMCITY_EDGE_{key} must be an integer.");
    }

    private static bool ParseBoolStrict(string? value, bool fallback, string key)
    {
        if (value is null)
            return fallback;
        return bool.TryParse(value, out var parsed)
            ? parsed
            : throw new ConnectorConfigurationException(
                $"SQLSIMCITY_EDGE_{key} must be true or false.");
    }

    private static ConnectorConfigurationException Missing(string key)
        => new($"Required environment variable SQLSIMCITY_EDGE_{key} is not set.");

    private static void RequireNonEmpty(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new ConnectorConfigurationException($"{name} must be configured.");
    }

    private static TimeSpan ParseSeconds(string? value, int fallback)
        => TimeSpan.FromSeconds(ParseInt(value, fallback));

    private static int ParseInt(string? value, int fallback)
        => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : fallback;

    private static long ParseLong(string? value, long fallback)
        => long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : fallback;

    private static bool ParseBool(string? value)
        => bool.TryParse(value, out var parsed) && parsed;
}

/// <summary>Raised when connector configuration is missing or invalid. Never contains secret material.</summary>
public sealed class ConnectorConfigurationException(string message) : Exception(message);
