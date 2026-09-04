using SqlSimCity.Collection.Probes;

namespace SqlSimCity.Api;

// One refresh can negotiate many databases. Reuse only target-scoped observations
// (including classified failures) within that cycle; never retain them across refreshes.
internal sealed class CapabilityCycleProbeExecutor(IProbeExecutor source) : IProbeExecutor
{
    private Task<ServerIdentityResult>? _identity;
    private Task<IReadOnlyList<DatabaseDiscoveryRow>>? _databases;
    private readonly Dictionary<string, Task<bool?>> _serverPermissions = new(StringComparer.Ordinal);

    public Task<ServerIdentityResult> GetServerIdentityAsync(CancellationToken cancellationToken) =>
        _identity ??= source.GetServerIdentityAsync(cancellationToken);

    public Task<IReadOnlyList<DatabaseDiscoveryRow>> GetDatabaseDiscoveryAsync(CancellationToken cancellationToken) =>
        _databases ??= source.GetDatabaseDiscoveryAsync(cancellationToken);

    public Task<bool?> CheckServerPermissionAsync(string permission, CancellationToken cancellationToken)
    {
        if (!_serverPermissions.TryGetValue(permission, out var result))
        {
            result = source.CheckServerPermissionAsync(permission, cancellationToken);
            _serverPermissions.Add(permission, result);
        }
        return result;
    }

    public Task<QueryStoreOptionsRow?> GetQueryStoreOptionsAsync(string databaseName, CancellationToken cancellationToken) =>
        source.GetQueryStoreOptionsAsync(databaseName, cancellationToken);

    public Task<QueryStorePlanMetadataResult> GetQueryStorePlanMetadataAsync(string databaseName, CancellationToken cancellationToken) =>
        source.GetQueryStorePlanMetadataAsync(databaseName, cancellationToken);

    public Task<bool?> CheckDatabasePermissionAsync(string databaseName, string permission, CancellationToken cancellationToken) =>
        source.CheckDatabasePermissionAsync(databaseName, permission, cancellationToken);

    public Task<AzureResourceGovernanceRow?> GetAzureResourceGovernanceAsync(string databaseName, CancellationToken cancellationToken) =>
        source.GetAzureResourceGovernanceAsync(databaseName, cancellationToken);
}
