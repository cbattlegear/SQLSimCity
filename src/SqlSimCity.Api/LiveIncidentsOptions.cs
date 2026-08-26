namespace SqlSimCity.Api;

/// <summary>
/// Root binding target for the <c>LiveIncidents</c> configuration section.
/// <see cref="Mode"/> defaults to <see cref="LiveIncidentsMode.Fixture"/> so an
/// operator who configures nothing keeps today's no-credentials behavior;
/// <see cref="Connection"/> is required, and validated, only when
/// <see cref="Mode"/> is <see cref="LiveIncidentsMode.Connected"/>.
/// </summary>
public sealed class LiveIncidentsOptions
{
    public const string SectionName = "LiveIncidents";

    /// <summary>Raw configured mode string; parsed explicitly in <c>LiveIncidentsServiceCollectionExtensions</c> so an unrecognized value is always a curated <see cref="LiveIncidentsConfigurationException"/>, never a binder-internal exception.</summary>
    public string Mode { get; set; } = nameof(LiveIncidentsMode.Fixture);

    public LiveIncidentsConnectionOptions Connection { get; set; } = new();

    /// <summary>How much of a sampled instance one live snapshot is allowed to carry.</summary>
    public LiveIncidentsSampleBoundsOptions SampleBounds { get; set; } = new();
}

/// <summary>
/// The bounds a live snapshot is collected under. They exist because both axes are unbounded by
/// anything SqlSimCity controls: an instance's session count, and the length of the batch text each
/// session is running. Measured against SQL Server 2022, 5,009 idle sessions carrying no batch text
/// produced a 5.88 MiB snapshot, and 50 sessions each executing a 1 MiB batch produced a 100.2 MiB
/// snapshot that took 4.35 s to collect -- longer than the sampler's own 2-5 s cadence -- and
/// allocated 103 GiB in the process. Every snapshot is rebroadcast whole to every connected client.
/// <para>
/// Each bound is a positive row/character count, or <c>0</c> to remove it entirely and restore the
/// unbounded behaviour. Nothing a bound omits is omitted silently: the snapshot reports the pre-cap
/// counts and each row reports its untruncated text lengths, so a bounded sample can always be told
/// apart from a smaller server or a shorter statement.
/// </para>
/// </summary>
public sealed class LiveIncidentsSampleBoundsOptions
{
    /// <summary>
    /// Maximum session/request rows in one snapshot; <c>0</c> for no cap. Rows are kept
    /// active-requests-first, then longest-running, then by session id.
    /// </summary>
    public int MaxRequestRows { get; set; } = 1_000;

    /// <summary>
    /// Maximum characters of batch text and of executing-statement text per row; <c>0</c> for no
    /// cap. Collection cost grows faster than linearly in this value -- measured at 250 concurrent
    /// 64 KiB batches, raising it from 16,384 to 65,536 took one snapshot from 8.4 MiB to 31.9 MiB
    /// and one cycle's allocation from 99 MiB to 1,158 MiB -- so raising it far is a deliberate
    /// trade rather than a free one.
    /// </summary>
    public int MaxTextLength { get; set; } = 16_384;

    /// <summary>
    /// Maximum tempdb session rows and task rows in one snapshot; <c>0</c> for no cap. Those DMVs
    /// carry a row per session and per task whether or not tempdb was touched, so they scale with
    /// connection count; the cap keeps the heaviest allocators.
    /// </summary>
    public int MaxTempdbRows { get; set; } = 1_000;
}

/// <summary>
/// The SQL Server (or Azure SQL) target and authentication a <c>Connected</c>-mode
/// <c>ILiveIncidentCollector</c> samples. Every field here is either a plain identifier/hostname
/// or a reference to a secret file (never a resolved secret value), so this whole options graph
/// is safe to bind, hold, and even log by field name.
/// </summary>
public sealed class LiveIncidentsConnectionOptions
{
    /// <summary>
    /// An optional ordinary ADO.NET connection string that replaces every field
    /// below except <see cref="TargetId"/>, <see cref="DisplayName"/>, and
    /// <see cref="Platform"/> (which all fall back to defaults). See
    /// <c>SqlSimCityConnectionString</c> for the shared keys it also honors.
    /// </summary>
    public string? ConnectionString { get; set; }

    /// <summary>A short, stable label for this target, used as the sampler's target id.</summary>
    public string? TargetId { get; set; }

    /// <summary>A human-readable label for this target, shown in the UI.</summary>
    public string? DisplayName { get; set; }

    /// <summary>
    /// The negotiated/configured platform this target runs on. Required in <c>Connected</c> mode
    /// (requirement 3): platform must never be inferred solely from a master-scoped identity
    /// probe that can fail for an Azure contained user, so an operator states it up front.
    /// </summary>
    public string? Platform { get; set; }

    public LiveIncidentsServerOptions Server { get; set; } = new();

    /// <summary>The initial/target database this collector samples (never <c>tempdb</c> itself; see <see cref="Platform"/> for tempdb scoping).</summary>
    public string? Database { get; set; }

    /// <summary><c>Mandatory</c> (default) or <c>Strict</c>; see <c>EncryptionPolicy</c>.</summary>
    public string Encryption { get; set; } = "Mandatory";

    public bool TrustServerCertificate { get; set; }

    public string? HostNameInCertificate { get; set; }

    public LiveIncidentsTimeoutOptions Timeouts { get; set; } = new();

    public LiveIncidentsPoolOptions Pool { get; set; } = new();

    public LiveIncidentsAuthenticationOptions Authentication { get; set; } = new();

    public LiveIncidentsSecretsOptions Secrets { get; set; } = new();
}

public sealed class LiveIncidentsServerOptions
{
    public string? Host { get; set; }

    public string? InstanceName { get; set; }

    public int? Port { get; set; }
}

public sealed class LiveIncidentsTimeoutOptions
{
    public int ConnectSeconds { get; set; } = 15;

    public int CommandSeconds { get; set; } = 10;
}

public sealed class LiveIncidentsPoolOptions
{
    public int MinPoolSize { get; set; }

    public int MaxPoolSize { get; set; } = 5;
}

/// <summary>
/// Selects one <c>AuthenticationStrategy</c>. Only <see cref="Mode"/>'s matching fields are read;
/// fields for other modes are ignored. <see cref="PasswordSecretFile"/> is a file name resolved
/// under <see cref="LiveIncidentsSecretsOptions.Directory"/> -- never a password value.
/// </summary>
public sealed class LiveIncidentsAuthenticationOptions
{
    /// <summary><c>SqlLogin</c>, <c>Kerberos</c>, or one explicit Microsoft Entra strategy.</summary>
    public string? Mode { get; set; }

    /// <summary>SQL login username (<c>SqlLogin</c> mode only).</summary>
    public string? Username { get; set; }

    /// <summary>Secret file name holding the SQL login password (<c>SqlLogin</c> mode only).</summary>
    public string? PasswordSecretFile { get; set; }

    /// <summary>Optional user-assigned managed identity client id (<c>ManagedIdentity</c> mode only; system-assigned when omitted).</summary>
    public string? UserAssignedClientId { get; set; }

    /// <summary>Entra tenant id (workload identity or service principal modes).</summary>
    public string? TenantId { get; set; }

    /// <summary>Entra application (client) id (workload identity or service principal modes).</summary>
    public string? ClientId { get; set; }

    /// <summary>Optional override of the projected federated token file path (<c>WorkloadIdentity</c> mode only).</summary>
    public string? FederatedTokenFilePath { get; set; }

    /// <summary>Secret file containing a PKCS#12/PFX client certificate.</summary>
    public string? CertificateSecretFile { get; set; }

    /// <summary>Optional secret file containing the PFX password.</summary>
    public string? CertificatePasswordSecretFile { get; set; }

    /// <summary>Secret file containing a service-principal client secret.</summary>
    public string? ClientSecretFile { get; set; }
}

public sealed class LiveIncidentsSecretsOptions
{
    public string Directory { get; set; } = "/run/secrets";

    public int MaxSecretSizeBytes { get; set; } = 16 * 1_024;
}
