using System.Data;
using System.Globalization;
using System.Numerics;
using Azure.Identity;
using Microsoft.Data.SqlClient;
using SqlSimCity.Collection.Catalog;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Collection.DatabaseCity;

public sealed class SqlClientDatabaseCityProbeExecutor(
    ISqlConnectionFactory connectionFactory,
    ConnectionProfile profile,
    ProbeCatalog catalog,
    TimeProvider timeProvider) : IDatabaseCityProbeExecutor
{
    public async Task<DatabaseCityProbePage> CollectPageAsync(
        string databaseName,
        int afterObjectId,
        int topN,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);
        ArgumentOutOfRangeException.ThrowIfNegative(afterObjectId);
        if (topN is < 1 or > 51)
            throw new ArgumentOutOfRangeException(nameof(topN));

        var inventory = await ExecuteAsync(
            "city.object_inventory_page",
            databaseName,
            new Dictionary<string, object?>
            {
                ["@AfterObjectId"] = afterObjectId,
                ["@TopN"] = topN,
            },
            async (reader, token) =>
            {
                var rows = new List<DatabaseCityInventoryRow>();
                string? totalObjects = null;
                while (await reader.ReadAsync(token).ConfigureAwait(false))
                {
                    // The probe repeats the same unbounded eligible-object count on every row.
                    totalObjects ??= NullableUnsigned(reader["total_objects"]);
                    rows.Add(new DatabaseCityInventoryRow(
                        Convert.ToInt32(reader["object_id"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["schema_id"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["schema_layout_ordinal"], CultureInfo.InvariantCulture),
                        Convert.ToString(reader["schema_name"], CultureInfo.InvariantCulture) ?? "",
                        Convert.ToString(reader["object_name"], CultureInfo.InvariantCulture) ?? "",
                        Convert.ToString(reader["object_type"], CultureInfo.InvariantCulture) == "INDEXED_VIEW"
                            ? DatabaseObjectKind.IndexedView
                            : DatabaseObjectKind.Table,
                        NullableUnsigned(reader["reserved_pages"]),
                        NullableUnsigned(reader["used_pages"]),
                        reader["index_id"] is DBNull
                            ? null
                            : Convert.ToInt32(reader["index_id"], CultureInfo.InvariantCulture),
                        reader["index_name"] is DBNull
                            ? null
                            : Convert.ToString(reader["index_name"], CultureInfo.InvariantCulture),
                        reader["index_type_desc"] is DBNull
                            ? null
                            : IndexKind(Convert.ToString(reader["index_type_desc"], CultureInfo.InvariantCulture))));
                }

                // A first page that selected nothing is proof the database holds no eligible
                // objects, so it reports a measured zero. A later page can only come back empty if
                // objects were dropped mid-walk, which leaves the total genuinely unknown.
                totalObjects ??= afterObjectId == 0 ? "0" : null;
                return (Rows: (IReadOnlyList<DatabaseCityInventoryRow>)rows, TotalObjects: totalObjects);
            },
            cancellationToken).ConfigureAwait(false);

        // Each of the two secondary probes gets its own try/catch. They read different DMVs with
        // different permissions, so a denial on one is not evidence about the other -- sharing a
        // catch would silently report index usage as denied because statistics were.
        var statistics = await CollectStatisticsAsync(databaseName, afterObjectId, topN, cancellationToken)
            .ConfigureAwait(false);

        try
        {
            var usage = await ExecuteAsync(
                "city.index_usage_page",
                databaseName,
                new Dictionary<string, object?>
                {
                    ["@AfterObjectId"] = afterObjectId,
                    ["@TopN"] = topN,
                },
                async (reader, token) =>
                {
                    var rows = new List<DatabaseCityIndexUsageRow>();
                    while (await reader.ReadAsync(token).ConfigureAwait(false))
                    {
                        var total = UnsignedInteger(reader["user_seeks"]) +
                                    UnsignedInteger(reader["user_scans"]) +
                                    UnsignedInteger(reader["user_lookups"]) +
                                    UnsignedInteger(reader["user_updates"]);
                        rows.Add(new DatabaseCityIndexUsageRow(
                            Convert.ToInt32(reader["object_id"], CultureInfo.InvariantCulture),
                            Convert.ToInt32(reader["index_id"], CultureInfo.InvariantCulture),
                            total.ToString(CultureInfo.InvariantCulture)));
                    }
                    return (IReadOnlyList<DatabaseCityIndexUsageRow>)rows;
                },
                cancellationToken).ConfigureAwait(false);
            return new DatabaseCityProbePage(
                inventory.Rows, usage, DataStatus.Available,
                "Direct cumulative index usage counters were collected; reset epoch is unavailable because database detach/shutdown resets are not timestamped.",
                timeProvider.GetUtcNow(),
                inventory.TotalObjects,
                statistics.Rows, statistics.Status, statistics.Reason);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (ProbePermissionDeniedException ex)
        {
            return new DatabaseCityProbePage(
                inventory.Rows, [], DataStatus.PermissionDenied, ex.Reason, timeProvider.GetUtcNow(),
                inventory.TotalObjects, statistics.Rows, statistics.Status, statistics.Reason);
        }
        catch (ProbeObjectUnavailableException ex)
        {
            return new DatabaseCityProbePage(
                inventory.Rows, [], DataStatus.Unsupported, ex.Reason, timeProvider.GetUtcNow(),
                inventory.TotalObjects, statistics.Rows, statistics.Status, statistics.Reason);
        }
    }

    private async Task<(IReadOnlyList<DatabaseCityStatisticsAgeRow> Rows, DataStatus Status, string Reason)>
        CollectStatisticsAsync(
            string databaseName,
            int afterObjectId,
            int topN,
            CancellationToken cancellationToken)
    {
        try
        {
            var rows = await ExecuteAsync(
                "city.statistics_age_page",
                databaseName,
                new Dictionary<string, object?>
                {
                    ["@AfterObjectId"] = afterObjectId,
                    ["@TopN"] = topN,
                },
                async (reader, token) =>
                {
                    var collected = new List<DatabaseCityStatisticsAgeRow>();
                    while (await reader.ReadAsync(token).ConfigureAwait(false))
                    {
                        collected.Add(new DatabaseCityStatisticsAgeRow(
                            Convert.ToInt32(reader["object_id"], CultureInfo.InvariantCulture),
                            reader["oldest_last_updated"] is DBNull
                                ? null
                                : new DateTimeOffset(
                                    DateTime.SpecifyKind(
                                        Convert.ToDateTime(reader["oldest_last_updated"], CultureInfo.InvariantCulture),
                                        DateTimeKind.Utc)),
                            Convert.ToInt32(reader["statistics_count"], CultureInfo.InvariantCulture),
                            Convert.ToInt32(reader["never_updated_count"], CultureInfo.InvariantCulture),
                            Convert.ToInt32(reader["unreadable_count"], CultureInfo.InvariantCulture),
                            NullableUnsigned(reader["max_modification_counter"])));
                    }
                    return (IReadOnlyList<DatabaseCityStatisticsAgeRow>)collected;
                },
                cancellationToken).ConfigureAwait(false);
            return (rows, DataStatus.Available,
                "Statistics freshness was read per object; an object is reported as fresh as its stalest statistic.");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (ProbePermissionDeniedException ex)
        {
            return ([], DataStatus.PermissionDenied, ex.Reason);
        }
        catch (ProbeObjectUnavailableException ex)
        {
            return ([], DataStatus.Unsupported, ex.Reason);
        }
    }

    private async Task<T> ExecuteAsync<T>(
        string probeId,
        string databaseName,
        Dictionary<string, object?>? values,
        Func<SqlDataReader, CancellationToken, Task<T>> projector,
        CancellationToken cancellationToken)
    {
        var probe = catalog.Get(probeId);
        if (!probe.ConnectionScope.Equals("database", StringComparison.Ordinal))
            throw new InvalidOperationException($"Probe '{probeId}' must be database scoped.");
        var databaseProfile = profile.WithInitialDatabase(databaseName);
        SqlConnectionOpenResult opened;
        try
        {
            opened = await connectionFactory.OpenAsync(databaseProfile, cancellationToken).ConfigureAwait(false);
        }
        catch (SqlException ex)
        {
            throw SqlExceptionClassifier.Classify(ex, probeId);
        }
        catch (SecretResolutionException ex)
        {
            throw new ProbeAuthenticationException(
                "A configured authentication secret was unavailable.", null, null, ex);
        }
        catch (CredentialUnavailableException ex)
        {
            throw new ProbeAuthenticationException(
                "The configured Microsoft Entra credential was unavailable.", null, null, ex);
        }
        catch (AuthenticationFailedException ex)
        {
            throw new ProbeAuthenticationException(
                "The configured Microsoft Entra authentication failed.", null, null, ex);
        }

        await using (opened.ConfigureAwait(false))
        await using (var command = opened.Connection.CreateCommand())
        {
            command.CommandType = CommandType.Text;
            command.CommandText = probe.CommandText;
            command.CommandTimeout = databaseProfile.Timeouts.CommandTimeoutSeconds;
            var parameters = SqlClientProbeExecutor.BuildParameters(probe, values);
            if (parameters.Length > 0)
                command.Parameters.AddRange(parameters);
            try
            {
                await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                return await projector(reader, cancellationToken).ConfigureAwait(false);
            }
            catch (SqlException ex)
            {
                throw SqlExceptionClassifier.Classify(ex, probeId);
            }
        }
    }

    private static string Unsigned(object value) =>
        UnsignedInteger(value).ToString(CultureInfo.InvariantCulture);

    private static string? NullableUnsigned(object value) =>
        value is DBNull ? null : Unsigned(value);

    private static BigInteger UnsignedInteger(object value)
    {
        var text = Convert.ToString(value, CultureInfo.InvariantCulture);
        if (!BigInteger.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) || parsed < 0)
            throw new ProbeDataFormatException("A database-city probe returned an invalid unsigned integer.");
        return parsed;
    }

    private static DatabaseIndexKind IndexKind(string? kind) => kind switch
    {
        "HEAP" => DatabaseIndexKind.Heap,
        "CLUSTERED" => DatabaseIndexKind.Clustered,
        "NONCLUSTERED" => DatabaseIndexKind.Nonclustered,
        "CLUSTERED COLUMNSTORE" or "NONCLUSTERED COLUMNSTORE" => DatabaseIndexKind.Columnstore,
        _ => DatabaseIndexKind.Other,
    };
}
