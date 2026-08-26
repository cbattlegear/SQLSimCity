using Microsoft.AspNetCore.RateLimiting;
using System.Threading.RateLimiting;
using SqlSimCity.Domain;
using SqlSimCity.Edge.Ingestion;
using SqlSimCity.Edge.Signing;

namespace SqlSimCity.Api;

/// <summary>
/// Opt-in configuration for central edge ingestion. Disabled by default: unless
/// <see cref="Enabled"/> is explicitly set, no ingestion endpoint is mapped and the app stays
/// strictly GET-only. When enabled, the connector allowlist and signing secrets are loaded from a
/// catalog plus a secrets directory (never inline), replay nonces are journaled to a durable path,
/// and every bound below is enforced.
/// </summary>
public sealed class EdgeIngestionOptions
{
    public const string SectionName = "EdgeIngestion";

    public bool Enabled { get; init; }
    public string? SecretCatalogFile { get; init; }
    public string? SecretsDirectory { get; init; }
    public string? NonceJournalPath { get; init; }
    public string? AllowedTargetId { get; init; }
    public int ClockSkewSeconds { get; init; } = 300;
    public long MaxBatchBytes { get; init; } = 4 * 1024 * 1024;
    public int RateLimitPermitPerMinute { get; init; } = 120;

    /// <summary>
    /// Maximum buffered bytes across every in-progress section group of one target. The default is
    /// five sections at the 32 MiB reassembly cap, so a connector operating within the existing
    /// per-section bound is never rejected by this one.
    /// </summary>
    public long MaxPendingBytesPerTarget { get; init; } = 160L * 1024 * 1024;

    /// <summary>Maximum buffered bytes across every in-progress section group of every target.</summary>
    public long MaxPendingBytesTotal { get; init; } = 320L * 1024 * 1024;

    /// <summary>Maximum in-progress section groups one target may hold open at once.</summary>
    public int MaxPendingGroupsPerTarget { get; init; } = 64;

    /// <summary>Maximum number of distinct targets the observation store will hold state for.</summary>
    public int MaxTargets { get; init; } = 64;

    public EdgeRetentionLimits Retention => new()
    {
        MaxPendingBytesPerTarget = MaxPendingBytesPerTarget,
        MaxPendingBytesTotal = MaxPendingBytesTotal,
        MaxPendingGroupsPerTarget = MaxPendingGroupsPerTarget,
        MaxTargets = MaxTargets,
    };

    public void Validate()
    {
        if (!Enabled)
            return;
        if (string.IsNullOrWhiteSpace(SecretCatalogFile))
            throw new InvalidOperationException($"{SectionName}:SecretCatalogFile is required when edge ingestion is enabled.");
        if (string.IsNullOrWhiteSpace(SecretsDirectory))
            throw new InvalidOperationException($"{SectionName}:SecretsDirectory is required when edge ingestion is enabled.");
        if (string.IsNullOrWhiteSpace(NonceJournalPath))
            throw new InvalidOperationException($"{SectionName}:NonceJournalPath is required when edge ingestion is enabled.");
        if (string.IsNullOrWhiteSpace(AllowedTargetId) || AllowedTargetId.Length > 128)
            throw new InvalidOperationException("Acquisition:Edge:TargetId must contain 1 to 128 characters when edge ingestion is enabled.");
        if (ClockSkewSeconds is < 5 or > 3600)
            throw new InvalidOperationException($"{SectionName}:ClockSkewSeconds must be between 5 and 3600.");
        if (MaxBatchBytes is < 4096 or > 64L * 1024 * 1024)
            throw new InvalidOperationException($"{SectionName}:MaxBatchBytes must be between 4 KiB and 64 MiB.");
        if (RateLimitPermitPerMinute is < 1 or > 100_000)
            throw new InvalidOperationException($"{SectionName}:RateLimitPermitPerMinute must be between 1 and 100000.");
        if (MaxPendingBytesPerTarget < MaxBatchBytes || MaxPendingBytesPerTarget > 1024L * 1024 * 1024)
            throw new InvalidOperationException($"{SectionName}:MaxPendingBytesPerTarget must be at least MaxBatchBytes and no more than 1 GiB.");
        if (MaxPendingBytesTotal < MaxPendingBytesPerTarget || MaxPendingBytesTotal > 8L * 1024 * 1024 * 1024)
            throw new InvalidOperationException($"{SectionName}:MaxPendingBytesTotal must be at least MaxPendingBytesPerTarget and no more than 8 GiB.");
        if (MaxPendingGroupsPerTarget is < 1 or > 4096)
            throw new InvalidOperationException($"{SectionName}:MaxPendingGroupsPerTarget must be between 1 and 4096.");
        if (MaxTargets is < 1 or > 4096)
            throw new InvalidOperationException($"{SectionName}:MaxTargets must be between 1 and 4096.");
    }
}

/// <summary>Holds the wired-up ingestion collaborators so endpoints resolve them from DI.</summary>
public sealed class EdgeIngestionContext(
    EdgeIngestionOptions options,
    HmacRequestVerifier verifier,
    EdgeObservationStore store,
    IngestionLimits limits)
{
    public EdgeIngestionOptions Options { get; } = options;
    public HmacRequestVerifier Verifier { get; } = verifier;
    public EdgeObservationStore Store { get; } = store;
    public IngestionLimits Limits { get; } = limits;
}

public static class EdgeIngestionServiceCollectionExtensions
{
    /// <summary>
    /// Registers edge ingestion only when explicitly enabled. Loads the connector allowlist/secrets
    /// and the durable replay-nonce journal, failing closed if any required file is missing or invalid.
    /// </summary>
    public static IServiceCollection AddEdgeIngestion(this IServiceCollection services, IConfiguration configuration)
    {
        var section = configuration.GetSection(EdgeIngestionOptions.SectionName);
        var options = new EdgeIngestionOptions
        {
            Enabled = section.GetValue<bool>(nameof(EdgeIngestionOptions.Enabled)),
            SecretCatalogFile = section.GetValue<string?>(nameof(EdgeIngestionOptions.SecretCatalogFile)),
            SecretsDirectory = section.GetValue<string?>(nameof(EdgeIngestionOptions.SecretsDirectory)),
            NonceJournalPath = section.GetValue<string?>(nameof(EdgeIngestionOptions.NonceJournalPath)),
            AllowedTargetId = configuration["Acquisition:Edge:TargetId"],
            ClockSkewSeconds = section.GetValue<int?>(nameof(EdgeIngestionOptions.ClockSkewSeconds)) ?? 300,
            MaxBatchBytes = section.GetValue<long?>(nameof(EdgeIngestionOptions.MaxBatchBytes)) ?? 4 * 1024 * 1024,
            RateLimitPermitPerMinute = section.GetValue<int?>(nameof(EdgeIngestionOptions.RateLimitPermitPerMinute)) ?? 120,
            MaxPendingBytesPerTarget = section.GetValue<long?>(nameof(EdgeIngestionOptions.MaxPendingBytesPerTarget)) ?? 160L * 1024 * 1024,
            MaxPendingBytesTotal = section.GetValue<long?>(nameof(EdgeIngestionOptions.MaxPendingBytesTotal)) ?? 320L * 1024 * 1024,
            MaxPendingGroupsPerTarget = section.GetValue<int?>(nameof(EdgeIngestionOptions.MaxPendingGroupsPerTarget)) ?? 64,
            MaxTargets = section.GetValue<int?>(nameof(EdgeIngestionOptions.MaxTargets)) ?? 64,
        };
        options.Validate();
        services.AddSingleton(options);

        if (!options.Enabled)
            return services;

        var secrets = ConnectorSecretCatalog.Load(options.SecretCatalogFile!, options.SecretsDirectory!);
        var nonces = new FileNonceReplayStore(options.NonceJournalPath!);
        services.AddSingleton<IConnectorSecretResolver>(secrets);
        services.AddSingleton<INonceReplayStore>(nonces);
        services.AddSingleton(new SignatureVerificationOptions(TimeSpan.FromSeconds(options.ClockSkewSeconds)));
        services.AddSingleton(new EdgeObservationStore(
            generationValidator: EdgeProjectionPayloadValidator.Validate,
            retention: options.Retention));
        services.AddSingleton(new IngestionLimits());
        services.AddRateLimiter(rateLimiter => rateLimiter.AddPolicy("edge-ingest", context =>
            RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown-edge-client",
                _ => new FixedWindowRateLimiterOptions
                {
                    AutoReplenishment = true,
                    PermitLimit = options.RateLimitPermitPerMinute,
                    QueueLimit = 0,
                    QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                    Window = TimeSpan.FromMinutes(1),
                })));
        services.AddSingleton(sp => new HmacRequestVerifier(
            sp.GetRequiredService<IConnectorSecretResolver>(),
            sp.GetRequiredService<INonceReplayStore>(),
            sp.GetRequiredService<SignatureVerificationOptions>(),
            sp.GetService<TimeProvider>() ?? TimeProvider.System));
        services.AddSingleton(sp => new EdgeIngestionContext(
            sp.GetRequiredService<EdgeIngestionOptions>(),
            sp.GetRequiredService<HmacRequestVerifier>(),
            sp.GetRequiredService<EdgeObservationStore>(),
            sp.GetRequiredService<IngestionLimits>()));
        return services;
    }

    public static IServiceCollection AddEdgeAcquisitionSource(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var section = configuration.GetSection("Acquisition:Edge");
        var options = new EdgeSourceOptions(
            section["TargetId"] ?? string.Empty,
            TimeSpan.FromSeconds(section.GetValue<int?>("StaleAfterSeconds") ?? 90),
            TimeSpan.FromSeconds(section.GetValue<int?>("DisconnectAfterSeconds") ?? 300));
        options.Validate();
        services.AddSingleton(options);
        services.AddSingleton<EdgeAcquisitionSource>();
        services.AddSingleton<IAtlasSnapshotSource>(provider => provider.GetRequiredService<EdgeAcquisitionSource>());
        services.AddSingleton<IAtlasCollectorStatusSource>(provider => provider.GetRequiredService<EdgeAcquisitionSource>());
        services.AddSingleton<ICapabilitiesSource>(provider => provider.GetRequiredService<EdgeAcquisitionSource>());
        services.AddSingleton<IQueryStoreHistorySource>(provider => provider.GetRequiredService<EdgeAcquisitionSource>());
        services.AddSingleton<IDatabaseCitySource>(provider => provider.GetRequiredService<EdgeAcquisitionSource>());
        services.AddSingleton<ILiveIncidentResponseSource>(provider => provider.GetRequiredService<EdgeAcquisitionSource>());
        return services;
    }
}
