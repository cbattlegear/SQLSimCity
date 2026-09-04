using System.Security.Cryptography;
using System.Text;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Archive;

public sealed class ArchiveRedactor(bool includeProtectedIdentifiers)
{
    public AtlasSnapshotV1 Redact(AtlasSnapshotV1 snapshot, string displayAlias) => snapshot with
    {
        SnapshotId = Identifier(snapshot.SnapshotId, "snapshot"),
        Target = snapshot.Target with
        {
            TargetId = Identifier(snapshot.Target.TargetId, "target"),
            DisplayName = displayAlias,
        },
        Databases = snapshot.Databases.Select(database => database with
        {
            DatabaseId = Identifier(database.DatabaseId, "database"),
            Name = RequiredIdentifier(database.Name, "database"),
            FileIo = database.FileIo is null
                ? null
                : database.FileIo with
                {
                    ResetEpochToken = OptionalIdentifier(
                        database.FileIo.ResetEpochToken,
                        "reset-epoch"),
                },
        }).ToArray(),
        Edges = snapshot.Edges.Select(edge => edge with
        {
            EdgeId = Identifier(edge.EdgeId, "edge"),
            FromDatabaseId = Identifier(edge.FromDatabaseId, "database"),
            ToDatabaseId = Identifier(edge.ToDatabaseId, "database"),
        }).ToArray(),
    };

    public CapabilitiesSnapshotV1 Redact(CapabilitiesSnapshotV1 snapshot) => snapshot with
    {
        Targets = snapshot.Targets.Select(target => target with
        {
            TargetId = Identifier(target.TargetId, "target"),
            Platform = target.Platform with
            {
                ProductVersion = includeProtectedIdentifiers ? target.Platform.ProductVersion : null,
                Edition = includeProtectedIdentifiers ? target.Platform.Edition : null,
            },
            Databases = target.Databases.Select(database => database with
            {
                DatabaseId = Identifier(database.DatabaseId, "database"),
                DatabaseName = RequiredIdentifier(database.DatabaseName, "database"),
            }).ToArray(),
            QueryStoreByDatabase = target.QueryStoreByDatabase.ToDictionary(
                pair => Identifier(pair.Key, "database"),
                pair => pair.Value,
                StringComparer.Ordinal),
        }).ToArray(),
    };

    public QueryFamilySummaryV1 Redact(QueryFamilySummaryV1 family) => family with
    {
        FamilyId = Identifier(family.FamilyId, "family"),
        DatabaseId = Identifier(family.DatabaseId, "database"),
        QueryHash = Identifier(family.QueryHash, "query-hash"),
        Text = Redact(family.Text),
        PhysicalQueries = family.PhysicalQueries.Select(query => query with
        {
            DatabaseId = Identifier(query.DatabaseId, "database"),
            QueryId = Identifier(query.QueryId, "query"),
            QueryTextId = Identifier(query.QueryTextId, "query-text"),
            QueryHash = Identifier(query.QueryHash, "query-hash"),
            Text = Redact(query.Text),
            Context = query.Context with
            {
                ContextSettingsId = Identifier(query.Context.ContextSettingsId, "query-context"),
                Language = includeProtectedIdentifiers ? query.Context.Language : null,
            },
        }).ToArray(),
    };

    public QueryFamilyDetailV1 Redact(QueryFamilyDetailV1 detail) => detail with
    {
        Family = Redact(detail.Family),
        Plans = detail.Plans.Select(plan => plan with
        {
            PlanId = Identifier(plan.PlanId, "plan"),
            QueryId = Identifier(plan.QueryId, "query"),
            QueryPlanHash = Identifier(plan.QueryPlanHash, "plan-hash"),
            DispatcherPlanId = OptionalIdentifier(plan.DispatcherPlanId, "plan"),
        }).ToArray(),
        Runtime = detail.Runtime.Select(runtime => runtime with
        {
            PlanId = Identifier(runtime.PlanId, "plan"),
            IntervalId = Identifier(runtime.IntervalId, "interval"),
            EpochId = Identifier(runtime.EpochId, "reset-epoch"),
            ReplicaGroupId = Identifier(runtime.ReplicaGroupId, "replica-group"),
        }).ToArray(),
    };

    public QueryStoreCollectorStatusV1 Redact(QueryStoreCollectorStatusV1 status) => status with
    {
        Databases = status.Databases.Select(database => database with
        {
            DatabaseId = Identifier(database.DatabaseId, "database"),
            ResetEpoch = Identifier(database.ResetEpoch, "reset-epoch"),
            Reason = includeProtectedIdentifiers
                ? database.Reason
                : database.Reason.Replace(
                    database.DatabaseId,
                    Identifier(database.DatabaseId, "database"),
                    StringComparison.Ordinal),
        }).ToArray(),
    };

    public NormalizedShowplanV1 Redact(NormalizedShowplanV1 plan) => plan with
    {
        PlanId = Identifier(plan.PlanId, "plan"),
        DispatcherExpression = includeProtectedIdentifiers ? plan.DispatcherExpression : null,
        Nodes = plan.Nodes.Select(node => node with
        {
            Predicate = includeProtectedIdentifiers ? node.Predicate : null,
            ObjectReference = node.ObjectReference is null ? null : node.ObjectReference with
            {
                Database = OptionalIdentifier(node.ObjectReference.Database, "database"),
                Schema = OptionalIdentifier(node.ObjectReference.Schema, "schema"),
                Table = OptionalIdentifier(node.ObjectReference.Table, "object"),
                Index = OptionalIdentifier(node.ObjectReference.Index, "index"),
            },
        }).ToArray(),
    };

    public DatabaseCitySummarySnapshotV1 Redact(DatabaseCitySummarySnapshotV1 snapshot) => snapshot with
    {
        Databases = snapshot.Databases.Select(database => database with
        {
            DatabaseId = Identifier(database.DatabaseId, "database"),
            Name = RequiredIdentifier(database.Name, "database"),
            Evidence = database.Evidence with
            {
                Reason = includeProtectedIdentifiers
                    ? database.Evidence.Reason
                    : database.Evidence.Reason.Replace(
                        database.Name,
                        RequiredIdentifier(database.Name, "database"),
                        StringComparison.Ordinal),
            },
        }).ToArray(),
    };

    public DatabaseCityPageV1 Redact(DatabaseCityPageV1 page) =>
        RedactCityPage(page, preserveMappingPresence: false);

    internal DatabaseCityPageV1 RedactForNamespaceResolution(DatabaseCityPageV1 page) =>
        RedactCityPage(page, preserveMappingPresence: true);

    private DatabaseCityPageV1 RedactCityPage(DatabaseCityPageV1 page, bool preserveMappingPresence)
    {
        var replacements = new List<(string Value, string Replacement)>
        {
            (page.DatabaseName, RequiredIdentifier(page.DatabaseName, "database")),
        };
        replacements.AddRange(page.Schemas.Select(schema =>
            (schema.Name, RequiredIdentifier(schema.Name, "schema"))));
        replacements.AddRange(page.Objects.Select(value =>
            (value.Name, RequiredIdentifier(value.Name, "object"))));
        replacements.AddRange(page.Objects.SelectMany(value => value.Indexes).Select(index =>
            (index.Name, RequiredIdentifier(index.Name, "index"))));
        string Scrub(string value) => includeProtectedIdentifiers
            ? value
            : replacements
                .Where(pair => !string.IsNullOrEmpty(pair.Value))
                .DistinctBy(pair => pair.Value, StringComparer.Ordinal)
                .OrderByDescending(pair => pair.Value.Length)
                .Aggregate(value, (current, pair) =>
                    current.Replace(pair.Value, pair.Replacement, StringComparison.Ordinal));

        var redacted = page with
        {
            DatabaseId = Identifier(page.DatabaseId, "database"),
            DatabaseName = RequiredIdentifier(page.DatabaseName, "database"),
            Schemas = page.Schemas.Select(schema => schema with
            {
                SchemaId = Identifier(schema.SchemaId, "schema"),
                Name = RequiredIdentifier(schema.Name, "schema"),
                Evidence = schema.Evidence with { Reason = Scrub(schema.Evidence.Reason) },
            }).ToArray(),
            Objects = page.Objects.Select(value => value with
            {
                ObjectId = Identifier(value.ObjectId, "object"),
                SchemaId = Identifier(value.SchemaId, "schema"),
                SchemaName = RequiredIdentifier(value.SchemaName, "schema"),
                Name = RequiredIdentifier(value.Name, "object"),
                SizeReason = value.SizeReason is null ? null : Scrub(value.SizeReason),
                Indexes = value.Indexes.Select(index => index with
                {
                    IndexId = Identifier(index.IndexId, "index"),
                    Name = RequiredIdentifier(index.Name, "index"),
                    DirectActivity = index.DirectActivity with
                    {
                        ResetEpochToken = OptionalIdentifier(
                            index.DirectActivity.ResetEpochToken,
                            "reset-epoch"),
                        Evidence = index.DirectActivity.Evidence with
                        {
                            Reason = Scrub(index.DirectActivity.Evidence.Reason),
                        },
                    },
                }).ToArray(),
                DirectActivity = value.DirectActivity with
                {
                    ResetEpochToken = OptionalIdentifier(
                        value.DirectActivity.ResetEpochToken,
                        "reset-epoch"),
                    Evidence = value.DirectActivity.Evidence with
                    {
                        Reason = Scrub(value.DirectActivity.Evidence.Reason),
                    },
                },
                AttributedExposure = value.AttributedExposure with
                {
                    Rationale = Scrub(value.AttributedExposure.Rationale),
                    // The shared rationale names the object it belongs to, so it carries the same
                    // schema-qualified identifiers the scrubber exists to remove.
                    Shared = value.AttributedExposure.Shared is { } shared
                        ? shared with { Rationale = Scrub(shared.Rationale) }
                        : null,
                    Evidence = value.AttributedExposure.Evidence with
                    {
                        Reason = Scrub(value.AttributedExposure.Evidence.Reason),
                    },
                },
            }).ToArray(),
            TopQueryFamilies = page.TopQueryFamilies.Select(family => family with
            {
                FamilyId = Identifier(family.FamilyId, "family"),
                QueryHash = Identifier(family.QueryHash, "query-hash"),
                ObjectIds = family.ObjectIds.Select(value => Identifier(value, "object")).ToArray(),
                Rationale = Scrub(family.Rationale),
                Evidence = family.Evidence with { Reason = Scrub(family.Evidence.Reason) },
            }).ToArray(),
            Routes = page.Routes.Select(route => route with
            {
                RouteId = Identifier(route.RouteId, "route"),
                FromObjectId = Identifier(route.FromObjectId, "object"),
                ToId = Identifier(
                    route.ToId,
                    route.Kind == DatabaseCityRouteKind.ObjectReference ? "object" : "database"),
                Rationale = Scrub(route.Rationale),
                Evidence = route.Evidence with { Reason = Scrub(route.Evidence.Reason) },
            }).ToArray(),
            Evidence = page.Evidence with { Reason = Scrub(page.Evidence.Reason) },
        };
        // The resolver must distinguish omission from explicit null; it ignores the omitted getter.
        return preserveMappingPresence && !page.HasQueryStoreDatabaseId
            ? redacted
            : redacted with { QueryStoreDatabaseId = OptionalIdentifier(page.QueryStoreDatabaseId, "database") };
    }

    public LiveIncidentResponseV1 Redact(LiveIncidentResponseV1 response) => response.Snapshot is null
        ? response
        : response with
        {
            Snapshot = response.Snapshot with
            {
                Target = response.Snapshot.Target with
                {
                    TargetId = Identifier(response.Snapshot.Target.TargetId, "target"),
                    DisplayName = "Imported SQL Server",
                },
                Requests = response.Snapshot.Requests.Select(request => request with
                {
                    RequestId = Identifier(request.RequestId, "request"),
                    LoginName = null,
                    HostName = null,
                    ProgramName = null,
                    CurrentStatementText = null,
                    BatchText = null,
                    DatabaseId = OptionalIdentifier(request.DatabaseId, "database"),
                    DatabaseName = OptionalIdentifier(request.DatabaseName, "database"),
                }).ToArray(),
                MemoryGrants = response.Snapshot.MemoryGrants.Select(grant => grant with
                {
                    BatchText = null,
                }).ToArray(),
                FileIo = response.Snapshot.FileIo with
                {
                    Files = response.Snapshot.FileIo.Files.Select(file => file with
                    {
                        DatabaseId = includeProtectedIdentifiers
                            ? file.DatabaseId
                            : ProtectedInteger(file.DatabaseId, "database"),
                        DatabaseName = OptionalIdentifier(file.DatabaseName, "database"),
                    }).ToArray(),
                },
            },
        };

    private QueryTextDescriptorV1 Redact(QueryTextDescriptorV1 text)
    {
        if (text.Availability != QueryTextAvailability.Available)
            return text with { NormalizedText = null };
        var normalized = SqlTextNormalizer.Normalize(
            text.NormalizedText,
            isEncrypted: false,
            isRestricted: false);
        var fingerprint = normalized.NormalizedTextFingerprint ??
            text.NormalizedTextFingerprint ??
            Fingerprint(text.NormalizedText ?? string.Empty);
        if (normalized.Availability != QueryTextAvailability.Available)
        {
            return new QueryTextDescriptorV1(
                QueryTextAvailability.Missing,
                null,
                fingerprint,
                "Query text failed ScriptDom normalization and was omitted; fingerprint retained.");
        }
        return text with
        {
            NormalizedText = includeProtectedIdentifiers ? normalized.NormalizedText : null,
            NormalizedTextFingerprint = fingerprint,
            Reason = includeProtectedIdentifiers
                ? normalized.Reason
                : "Normalized query text omitted by the archive redaction policy; fingerprint retained.",
        };
    }

    public string Identifier(string value, string kind) =>
        includeProtectedIdentifiers || IsProtectedIdentifier(value, kind)
            ? value
            : $"{kind}-{Fingerprint($"{kind}:{value}")[..12]}";

    private string RequiredIdentifier(string value, string kind) =>
        Identifier(value, kind);

    private string? OptionalIdentifier(string? value, string kind) =>
        value is null ? null : Identifier(value, kind);

    private static string Fingerprint(string value) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static bool IsProtectedIdentifier(string value, string kind)
    {
        var prefix = kind + "-";
        return value.Length == prefix.Length + 12 &&
               value.StartsWith(prefix, StringComparison.Ordinal) &&
               value[prefix.Length..].All(character =>
                   character is >= '0' and <= '9' or >= 'a' and <= 'f');
    }

    private static int ProtectedInteger(int value, string kind)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"{kind}:{value}"));
        return BitConverter.ToInt32(bytes.AsSpan(0, sizeof(int))) & int.MaxValue;
    }
}
