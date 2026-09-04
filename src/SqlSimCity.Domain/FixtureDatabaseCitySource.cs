using System.Collections.ObjectModel;
using System.Globalization;
using System.Numerics;
using System.Text;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain.DatabaseCity;

namespace SqlSimCity.Domain;

public sealed class FixtureDatabaseCitySource : IDatabaseCitySource
{
    private const string SalesDatabaseId = "fixture-target-primary/database/sales";
    private const int QueryFamilyTopCount = 12;
    private static readonly DateTimeOffset CapturedAt = new(2026, 8, 17, 17, 0, 0, TimeSpan.Zero);
    private static readonly EvidenceV1 FixtureEvidence = new(
        EvidenceSource.Fixture, DataStatus.Available, CapturedAt, CapturedAt.AddHours(1),
        "Sanitized deterministic database-city fixture evidence.");
    private static readonly EvidenceV1 DirectEvidence = new(
        EvidenceSource.LiveDmvCumulative, DataStatus.Available, CapturedAt, CapturedAt.AddMinutes(5),
        "Direct cumulative index usage DMV counters; values share reset epoch fixture-epoch-1.");
    private static readonly EvidenceV1 AttributedEvidence = new(
        EvidenceSource.QueryStoreAggregate, DataStatus.Available, CapturedAt, null,
        "Query Store aggregate exposure attributed only where normalized compiled-plan evidence names the object.");
    private static readonly IReadOnlyList<DatabaseCitySchemaEvidence> SalesSchemas =
    [
        new("schema:dbo", "dbo"),
        new("schema:reporting", "reporting"),
        new("schema:zarchive", "archive"),
    ];
    private static readonly IReadOnlyList<DatabaseCityObjectV1> SalesObjects =
        DatabaseCityProjector.ProjectObjects(SalesSchemas, BuildObjects());
    private static readonly IReadOnlyList<DatabaseCityQueryEvidence> SalesQueries = BuildQueries();
    private static readonly IReadOnlyList<DatabaseCitySummaryV1> Summaries = BuildSummaries();

    public ValueTask<DatabaseCitySummarySnapshotV1> GetSummariesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(new DatabaseCitySummarySnapshotV1("1.0", CapturedAt, Summaries));
    }

    public Task<DatabaseCityPageV1?> GetDatabaseAsync(
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize,
        string? pageToken,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseId);
        if (pageSize is < 1 or > 50)
            throw new ArgumentOutOfRangeException(nameof(pageSize));

        var summary = Summaries.SingleOrDefault(item =>
            item.DatabaseId.Equals(databaseId, StringComparison.Ordinal));
        if (summary is null)
            return Task.FromResult<DatabaseCityPageV1?>(null);

        var offset = DecodeToken(pageToken, databaseId, metric, pageSize);
        if (!databaseId.Equals(SalesDatabaseId, StringComparison.Ordinal))
        {
            if (offset != 0)
                throw new DatabaseCityPageTokenException();
            return Task.FromResult<DatabaseCityPageV1?>(UnavailablePage(summary, metric, pageSize));
        }

        if (offset > SalesObjects.Count)
            throw new DatabaseCityPageTokenException();
        var objects = SalesObjects.Skip(offset).Take(pageSize).ToArray();
        var nextOffset = offset + objects.Length;
        var nextPageToken = nextOffset < SalesObjects.Count
            ? EncodeToken(databaseId, metric, pageSize, nextOffset)
            : null;
        var workload = DatabaseCityProjector.ProjectWorkload(
            SalesQueries, metric, QueryFamilyTopCount, cancellationToken);
        var topFamilies = workload.Top.Select(ToContract).ToArray();
        var schemaContracts = SalesSchemas
            .OrderBy(schema => schema.SchemaId, StringComparer.Ordinal)
            .Select((schema, index) => new DatabaseCitySchemaV1(
                schema.SchemaId,
                schema.Name,
                index,
                SalesObjects.Count(item => item.SchemaId == schema.SchemaId).ToString(CultureInfo.InvariantCulture),
                FixtureEvidence))
            .ToArray();

        return Task.FromResult<DatabaseCityPageV1?>(new DatabaseCityPageV1(
            "1.0",
            databaseId,
            summary.Name,
            metric,
            pageSize,
            nextPageToken,
            SalesObjects.Count.ToString(CultureInfo.InvariantCulture),
            schemaContracts,
            objects,
            topFamilies,
            workload.Other,
            BuildRoutes(),
            FixtureEvidence)
        {
            QueryStoreDatabaseId = "sales",
        });
    }

    private static DatabaseCityPageV1 UnavailablePage(
        DatabaseCitySummaryV1 summary,
        DatabaseCityMetric metric,
        int pageSize)
    {
        var evidence = summary.Evidence;
        var knownEmpty = evidence.Status == DataStatus.Available &&
                         summary.SchemaCount == "0" &&
                         summary.ObjectCount == "0";
        var other = new DatabaseCityWorkloadAggregateV1(
            knownEmpty ? "0" : null,
            knownEmpty ? "0" : null,
            knownEmpty ? "0" : null,
            knownEmpty ? "0" : null,
            knownEmpty ? "0" : null,
            knownEmpty ? "0" : null,
            evidence);
        return new DatabaseCityPageV1(
            "1.0", summary.DatabaseId, summary.Name, metric, pageSize, null,
            knownEmpty ? "0" : null,
            [], [], [], other, [], evidence)
        {
            QueryStoreDatabaseId = null,
        };
    }

    private static IReadOnlyList<DatabaseCityObjectEvidence> BuildObjects()
    {
        var customerId = "object:dbo:100";
        var orderId = "object:dbo:110";
        var detailId = "object:dbo:120";
        var rollupId = "object:reporting:300";
        return
        [
            new DatabaseCityObjectEvidence(
                customerId, "schema:dbo", "Customer", DatabaseObjectKind.Table,
                "65536", "49152",
                [
                    Index(customerId, 1, "PK_Customer", DatabaseIndexKind.Clustered, "9512"),
                    Index(customerId, 2, "IX_Customer_Email", DatabaseIndexKind.Nonclustered, "2041"),
                ],
                ["qf:sales-orders", "family:sales:004"])
            {
                DirectActivity = Direct("11553"),
                AttributedExposure = Exposure("2276", "14089536", "25779084", "625203",
                    QueryAttributionConfidence.Confirmed,
                    "Only normalized single-database plans that name dbo.Customer contribute; multi-object plans are excluded.")
                with
                {
                    // Family 6 names dbo.Customer, dbo.OrderHeader, and dbo.OrderDetail together, so
                    // it cannot be attributed to any of them. Its totals appear whole on all three.
                    Shared = Shared("1", "1010", "10000030", "18000070", "520130"),
                },
            },
            new DatabaseCityObjectEvidence(
                orderId, "schema:dbo", "OrderHeader", DatabaseObjectKind.Table,
                "131072", "98304",
                [
                    Index(orderId, 1, "PK_OrderHeader", DatabaseIndexKind.Clustered, "24001"),
                    Index(orderId, 3, "IX_OrderHeader_Status", DatabaseIndexKind.Nonclustered, "8800"),
                ],
                ["family:sales:002", "family:sales:005"])
            {
                DirectActivity = Direct("32801"),
                AttributedExposure = Exposure("2525", "25000075", "45000175", "1300325",
                    QueryAttributionConfidence.Confirmed,
                    "Only normalized single-object plan references to dbo.OrderHeader contribute.")
                with
                {
                    // Families 6 and 7 both name dbo.OrderHeader alongside something else -- Customer
                    // and dbo.OrderDetail in one case, a cross-database target in the other -- so
                    // neither can be attributed to it. Their totals are the sums of those two rows
                    // exactly as BuildQueries emits them, carried whole rather than divided.
                    Shared = Shared("2", "1919", "19000057", "34200133", "988247"),
                },
            },
            new DatabaseCityObjectEvidence(
                detailId, "schema:dbo", "OrderDetail", DatabaseObjectKind.Table,
                "212992", "196608",
                [
                    Index(detailId, 1, "PK_OrderDetail", DatabaseIndexKind.Clustered, "41207"),
                    Index(detailId, 2, "IX_OrderDetail_OrderId", DatabaseIndexKind.Nonclustered, "17330"),
                ],
                ["family:sales:006"])
            {
                DirectActivity = Direct("58911"),
                // The case issue #40 reported: a normalized child table that no ranked query ever
                // names on its own, because it is only ever read through a join. Its attributed
                // totals stay null -- nothing was measured for it alone -- while the query-level
                // totals it participates in are reported whole. Without this object the fixture
                // would only ever show the easy world where every table has its own queries.
                AttributedExposure = Unattributed(
                    "No ranked Query Store family names dbo.OrderDetail on its own; every plan that reads it also names dbo.OrderHeader, so no total is measured for this object alone.")
                with
                {
                    Shared = Shared("1", "1010", "10000030", "18000070", "520130"),
                },
            },
            new DatabaseCityObjectEvidence(
                rollupId, "schema:reporting", "SalesRollup", DatabaseObjectKind.IndexedView,
                "8192", "8100",
                [
                    Index(rollupId, 1, "CIX_SalesRollup", DatabaseIndexKind.Clustered, "144"),
                ],
                ["family:sales:003"])
            {
                DirectActivity = Direct("144"),
                AttributedExposure = Exposure("1313", "13000039", "23400091", "676169",
                    QueryAttributionConfidence.Probable,
                    "A normalized plan names the indexed view; optimizer expansion remains a caveat."),
            },
            new DatabaseCityObjectEvidence(
                "object:zarchive:900", "schema:zarchive", "ColdLedger", DatabaseObjectKind.Table,
                null, null, [], [])
            {
                SizeReason = "The fixture principal was denied object space metadata.",
                DirectActivity = new DatabaseCityDirectActivityV1(
                    null, "fixture-epoch-1",
                    new EvidenceV1(EvidenceSource.LiveDmvCumulative, DataStatus.PermissionDenied,
                        CapturedAt, CapturedAt.AddMinutes(5), "Index usage DMV access was denied.")),
            },
        ];
    }

    private static List<DatabaseCityQueryEvidence> BuildQueries()
    {
        var rows = new List<DatabaseCityQueryEvidence>();
        for (var index = 1; index <= 15; index++)
        {
            var objectIds = index switch
            {
                1 or 4 => new[] { "object:dbo:100" },
                2 or 5 => new[] { "object:dbo:110" },
                3 => new[] { "object:reporting:300" },
                6 => new[] { "object:dbo:100", "object:dbo:110", "object:dbo:120" },
                7 => new[] { "object:dbo:110", "fixture-target-primary/database/warehouse" },
                _ => Array.Empty<string>(),
            };
            // Family 3 names exactly one object, but it is an indexed view whose optimizer expansion
            // is a caveat, so a single-object reference is not automatically Confirmed. This matches
            // reporting.SalesRollup's own Probable exposure, and the city draws its lanes dashed for
            // that reason.
            var confidence = index == 3
                ? QueryAttributionConfidence.Probable
                : objectIds.Length switch
                {
                    1 => QueryAttributionConfidence.Confirmed,
                    > 1 => QueryAttributionConfidence.Probable,
                    _ => QueryAttributionConfidence.Unknown,
                };
            var rationale = index == 3
                ? "A normalized plan names the indexed view reporting.SalesRollup; optimizer expansion remains a caveat, so the single object reference is probable rather than confirmed."
                : objectIds.Length switch
                {
                    1 => "A normalized compiled plan names exactly one local object.",
                    > 1 => "A normalized plan names multiple objects; totals remain query-level and are reported whole on each named object rather than divided between them.",
                    _ => "No normalized object reference was available; workload remains unattributed.",
                };
            var waitCategories = WaitCategories(index);
            var weight = 16 - index;
            if (index == 1)
            {
                rows.Add(new DatabaseCityQueryEvidence(
                    "qf:sales-orders",
                    "0x94A001",
                    "1064",
                    "2089500",
                    "4179000",
                    "1047",
                    "287",
                    objectIds,
                    confidence,
                    rationale)
                {
                    WaitMillisecondsByCategory = waitCategories,
                    WaitAttribution = Apportion(index, "287"),
                    PlanDataVolume = Volume(index),
                });
                continue;
            }
            if (index >= 13)
            {
                rows.Add(new DatabaseCityQueryEvidence(
                    $"family:sales:{index:D3}",
                    $"0xFAKE{index:D4}",
                    ((16 - index) * 10).ToString(CultureInfo.InvariantCulture),
                    ((16 - index) * 100).ToString(CultureInfo.InvariantCulture),
                    ((16 - index) * 200).ToString(CultureInfo.InvariantCulture),
                    ((16 - index) * 10).ToString(CultureInfo.InvariantCulture),
                    (16 - index).ToString(CultureInfo.InvariantCulture),
                    objectIds,
                    confidence,
                    rationale)
                {
                    WaitMillisecondsByCategory = waitCategories,
                    WaitAttribution = Apportion(index, (16 - index).ToString(CultureInfo.InvariantCulture)),
                    PlanDataVolume = Volume(index),
                });
                continue;
            }
            var totalWait = (weight * 1_009L).ToString(CultureInfo.InvariantCulture);
            rows.Add(new DatabaseCityQueryEvidence(
                $"family:sales:{index:D3}",
                $"0xFAKE{index:D4}",
                (weight * 101).ToString(CultureInfo.InvariantCulture),
                (weight * 1_000_003L).ToString(CultureInfo.InvariantCulture),
                (weight * 1_800_007L).ToString(CultureInfo.InvariantCulture),
                (weight * 52_013L).ToString(CultureInfo.InvariantCulture),
                totalWait,
                objectIds,
                confidence,
                rationale)
            {
                WaitMillisecondsByCategory = waitCategories,
                WaitAttribution = Apportion(index, totalWait),
                PlanDataVolume = Volume(index),
            });
        }
        return rows;
    }

    /// <summary>
    /// Estimated plan cost shares per fixture family, in the shape a compiled plan's operator costs
    /// would produce. These are invented, like every other number in this fixture -- but the division
    /// they drive is not: it runs through the same <see cref="WaitApportionment"/> the connected
    /// collector uses, so the offline demo exercises the production arithmetic rather than displaying
    /// hand-written results.
    ///
    /// <para>
    /// The set is chosen to make each behaviour visible without a live server. Family 6 reads three
    /// tables with genuinely uneven cost, which is the case the whole feature exists for. Family 7
    /// reads one local table and one in another database, and only the local share is published, so
    /// the refusal to hand cross-database cost to a drawn building shows up as a large unattributed
    /// remainder. Families 9 and above carry no shares at all -- the same deliberate gap their wait
    /// categories leave -- so the "no compiled plan cost estimate was available" path stays
    /// demonstrable offline rather than only asserted in a test.
    /// </para>
    /// </summary>
    private static DatabaseCityWaitAttributionV1 Apportion(int index, string totalWaitMilliseconds)
    {
        ObjectCostShare[] shares = index switch
        {
            1 or 4 => [new ObjectCostShare("object:dbo:100", 1m)],
            2 or 5 => [new ObjectCostShare("object:dbo:110", 1m)],
            3 => [new ObjectCostShare("object:reporting:300", 1m)],
            6 =>
            [
                new ObjectCostShare("object:dbo:110", 0.55m),
                new ObjectCostShare("object:dbo:120", 0.30m),
                new ObjectCostShare("object:dbo:100", 0.15m),
            ],
            7 => [new ObjectCostShare("object:dbo:110", 0.62m)],
            _ => [],
        };
        if (shares.Length == 0)
        {
            return DatabaseCityWaitAttributionV1.None;
        }
        var rationale = index == 7
            ? "Apportioned by estimated plan cost across 1 compiled plan. The remainder is cost the plan spent in another database, which is not this page's to place."
            : $"Apportioned by estimated plan cost across 1 compiled plan reading {shares.Length} object(s) on this page.";
        return WaitApportionment.Apportion(shares, totalWaitMilliseconds, 1, rationale);
    }

    /// <summary>
    /// Estimated per-execution data volume per fixture family, in the shape a compiled plan's
    /// <c>EstimateRows</c> and <c>AvgRowSize</c> would produce. Invented like every other number
    /// here, and the field's own rationale says so on every family that carries one.
    ///
    /// <para>
    /// The set spans four orders of magnitude on purpose. A reader with no server to point at should
    /// still see the whole range the city can draw -- a family moving a few hundred bytes and one
    /// moving hundreds of megabytes -- rather than a single middling value repeated. Concretely, at
    /// least one family lands in each band the vehicle ladder divides this measurement into
    /// (64 KiB and 8 MiB and 512 MiB are its cut points), because a band with no fixture family in it
    /// is a vehicle class nobody can see without a live server.
    /// <c>FixtureSourcePlanDataVolumesSpanEveryVehicleBandSoNoClassIsInvisibleOffline</c> pins that,
    /// and it is the reason these
    /// values are spread rather than clustered. Family 7 reads mostly in another database, so its
    /// total exceeds the sum of its per-object entries and the "bytes read from objects this page
    /// does not draw" disclosure stays demonstrable offline.
    /// </para>
    ///
    /// <para>
    /// Families 9 and above carry none, matching the gap their wait categories and cost shares
    /// already leave, so the absent case -- "no retained plan stated a row size", which must never
    /// be drawn as the smallest vehicle -- is visible without a live server.
    /// </para>
    /// </summary>
    private static DatabaseCityPlanDataVolumeV1? Volume(int index)
    {
        (string ObjectId, long Bytes)[] byObject = index switch
        {
            1 => [("object:dbo:100", 41_984)],
            2 => [("object:dbo:110", 3_072)],
            3 => [("object:reporting:300", 780_140_544)],
            4 => [("object:dbo:100", 512)],
            5 => [("object:dbo:110", 1_572_864)],
            6 =>
            [
                ("object:dbo:100", 1_048_576),
                ("object:dbo:110", 6_291_456),
                ("object:dbo:120", 2_097_152),
            ],
            7 => [("object:dbo:110", 65_536)],
            8 => [("object:dbo:120", 134_217_728)],
            _ => [],
        };
        if (byObject.Length == 0)
        {
            return null;
        }

        var onPage = byObject.Sum(entry => entry.Bytes);

        // Family 7's plan reads a table in another database. Those bytes are real work the query
        // does, so they stay in the total; they are simply not this page's to place on a building.
        var total = index == 7 ? onPage + 402_653_184 : onPage;

        var rationale = index == 7
            ? $"Estimated from row counts and row sizes in 1 compiled plan retained for this family. {onPage.ToString(CultureInfo.InvariantCulture)} of {total.ToString(CultureInfo.InvariantCulture)} byte(s) per execution are read from 1 object this page draws; the remainder is read from another database and is counted in the total but not placed on a building. These are the optimizer's compile-time estimates against the statistics that existed then, not a measurement of any execution."
            : $"Estimated from row counts and row sizes in 1 compiled plan retained for this family. All {total.ToString(CultureInfo.InvariantCulture)} byte(s) per execution are read from {byObject.Length.ToString(CultureInfo.InvariantCulture)} object(s) this page draws. These are the optimizer's compile-time estimates against the statistics that existed then, not a measurement of any execution.";

        return new DatabaseCityPlanDataVolumeV1(
            total.ToString(CultureInfo.InvariantCulture),
            [.. byObject.Select(entry => new DatabaseCityObjectDataVolumeV1(
                entry.ObjectId,
                entry.Bytes.ToString(CultureInfo.InvariantCulture)))],
            1,
            rationale);
    }

    /// <summary>
    /// Captured Query Store wait categories per fixture family, using verbatim
    /// <c>wait_category_desc</c> text. Each family's category totals sum exactly to its
    /// <c>TotalWaitMilliseconds</c>. Families 9 and above deliberately carry none, so the "no
    /// captured wait-category evidence" path -- the one a SQL Server 2016 (13.x) target always takes,
    /// because <c>sys.query_store_wait_stats</c> does not exist there -- stays demonstrable offline.
    /// The set spans categories that map to a facility (Buffer IO, Tran Log IO, Memory, Lock, CPU,
    /// Worker Thread, Log Rate Governor) and categories that deliberately do not (Network IO,
    /// Parallelism, Buffer Latch), so the unmapped-waits disclosure is exercised too. Families 6 and
    /// 7 name several objects and family 8 names none, so the city's refusal to divide query-level
    /// wait time between objects -- or to hand it all to whichever object is loaded -- is visible
    /// offline rather than only asserted in a test.
    /// </summary>
    private static ReadOnlyDictionary<string, string> WaitCategories(int index) => index switch
    {
        1 => Waits(("Buffer IO", "180"), ("Lock", "62"), ("Network IO", "45")),
        2 => Waits(("Tran Log IO", "9000"), ("Memory", "3000"), ("Buffer Latch", "1500"), ("Parallelism", "626")),
        3 => Waits(("CPU", "7000"), ("Buffer IO", "4000"), ("Log Rate Governor", "2117")),
        4 => Waits(("Memory", "8108"), ("Worker Thread", "4000")),
        5 => Waits(("Lock", "11099")),
        6 => Waits(("Buffer IO", "10090")),
        7 => Waits(("Lock", "9081")),
        8 => Waits(("Memory", "8072")),
        _ => ReadOnlyDictionary<string, string>.Empty,
    };

    private static ReadOnlyDictionary<string, string> Waits(params (string Category, string Milliseconds)[] entries) =>
        new(entries.ToDictionary(entry => entry.Category, entry => entry.Milliseconds, StringComparer.Ordinal));

    private static DatabaseCityQueryFamilyV1 ToContract(DatabaseCityQueryEvidence family) => new(
        family.FamilyId,
        family.QueryHash,
        family.ExecutionCount,
        family.TotalCpuMicroseconds,
        family.TotalDurationMicroseconds,
        family.TotalLogicalReads8KiBPages,
        family.TotalWaitMilliseconds,
        family.WaitMillisecondsByCategory,
        family.ObjectIds,
        family.Confidence,
        family.Rationale,
        AttributedEvidence)
    {
        WaitAttribution = family.WaitAttribution,
        PlanDataVolume = family.PlanDataVolume,
        RecentActivity = family.RecentActivity,
    };

    private static DatabaseCityIndexV1 Index(
        string objectId,
        int indexId,
        string name,
        DatabaseIndexKind kind,
        string operations) =>
        new($"{objectId}/index/{indexId}", name, kind, Direct(operations));

    private static DatabaseCityDirectActivityV1 Direct(string operations) =>
        new(operations, "fixture-epoch-1", DirectEvidence);

    private static DatabaseCityAttributedExposureV1 Exposure(
        string executions,
        string cpu,
        string duration,
        string reads,
        QueryAttributionConfidence confidence,
        string rationale) =>
        new(executions, cpu, duration, reads, confidence, rationale, AttributedEvidence);

    /// <summary>
    /// An object no ranked family names on its own. Every total is null because none was measured for
    /// this object alone -- not because the probe failed, which is why the evidence stays Available.
    /// </summary>
    private static DatabaseCityAttributedExposureV1 Unattributed(string rationale) =>
        new(null, null, null, null, QueryAttributionConfidence.Unknown, rationale, AttributedEvidence);

    /// <summary>
    /// Query-level totals from families that named this object alongside others. These repeat in full
    /// on every object those families named, so summing them across the city double-counts.
    /// </summary>
    private static DatabaseCitySharedExposureV1 Shared(
        string familyCount,
        string executions,
        string cpu,
        string duration,
        string reads) =>
        new(familyCount, executions, cpu, duration, reads,
            "Totals belong to queries that named several objects; they are shown whole on each and must not be summed across buildings.");

    private static IReadOnlyList<DatabaseCityRouteV1> BuildRoutes() =>
    [
        new("route:customer-orders", "object:dbo:110", "object:dbo:100",
            DatabaseCityRouteKind.ObjectReference, EdgeConfidence.Confirmed,
            "Normalized plan evidence references both local objects; this route identifies co-reference, not row flow.",
            new EvidenceV1(EvidenceSource.InferredTopology, DataStatus.Available,
                CapturedAt, null, "Confirmed normalized local object references.")),
        new("route:orders-warehouse", "object:dbo:110", "fixture-target-primary/database/warehouse",
            DatabaseCityRouteKind.CrossDatabaseReference, EdgeConfidence.Probable,
            "A three-part normalized plan reference names warehouse; direction and row flow are not established.",
            new EvidenceV1(EvidenceSource.InferredTopology, DataStatus.Stale,
                CapturedAt.AddHours(-2), CapturedAt.AddHours(-1), "Stale cross-database normalized plan evidence.")),
        new("route:rollup-ledger", "object:reporting:300", "fixture-target-primary/database/ledger",
            DatabaseCityRouteKind.CrossDatabaseReference, EdgeConfidence.Unknown,
            "A restricted plan mentions both identities but cannot establish a dependency or row flow.",
            new EvidenceV1(EvidenceSource.InferredTopology, DataStatus.Unknown,
                CapturedAt, null, "Restricted cross-database evidence.")),
    ];

    private static IReadOnlyList<DatabaseCitySummaryV1> BuildSummaries()
    {
        var available = FixtureEvidence;
        return
        [
            Summary("master", "master", "0", "0", "0", available),
            Summary("sales", "sales", "3", SalesObjects.Count.ToString(CultureInfo.InvariantCulture),
                null, new EvidenceV1(EvidenceSource.Fixture, DataStatus.Unknown, CapturedAt, CapturedAt.AddHours(1),
                    "At least one object has unknown size, so no exact database-city reserved-byte total is reported.")),
            Summary("ledger", "ledger", null, null, null,
                Unavailable(DataStatus.Stale, "Object metadata is stale and was withheld from this projection.")),
            Summary("warehouse", "warehouse", null, null, null,
                Unavailable(DataStatus.PermissionDenied, "Object catalog access was denied.")),
            Summary("telemetry", "telemetry", "0", "0", "0", available),
            Summary("archive", "archive", null, null, null,
                Unavailable(DataStatus.Unknown, "Object size evidence is unavailable.")),
            Summary("scratch", "scratch", null, null, null,
                Unavailable(DataStatus.Unsupported, "Database-city object probes are unsupported for this fixture database.")),
            Summary("crm", "crm", null, null, null,
                Unavailable(DataStatus.Disconnected, "The database was disconnected during object collection.")),
        ];
    }

    private static DatabaseCitySummaryV1 Summary(
        string id,
        string name,
        string? schemas,
        string? objects,
        string? reservedBytes,
        EvidenceV1 evidence) =>
        new($"fixture-target-primary/database/{id}", name, schemas, objects, reservedBytes,
            reservedBytes is null ? MeasurementStatus.Unknown : MeasurementStatus.Known, evidence);

    private static EvidenceV1 Unavailable(DataStatus status, string reason) =>
        new(EvidenceSource.Fixture, status, CapturedAt, CapturedAt.AddMinutes(-1), reason);

    private static string EncodeToken(
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize,
        int offset)
    {
        var bytes = Encoding.UTF8.GetBytes(
            $"1|{databaseId}|{metric}|{pageSize.ToString(CultureInfo.InvariantCulture)}|{offset.ToString(CultureInfo.InvariantCulture)}");
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static int DecodeToken(
        string? token,
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize)
    {
        if (token is null)
            return 0;
        if (token.Length is < 1 or > 1024 || token.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_')))
            throw new DatabaseCityPageTokenException();
        try
        {
            var base64 = token.Replace('-', '+').Replace('_', '/');
            base64 = base64.PadRight((base64.Length + 3) / 4 * 4, '=');
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(base64)).Split('|');
            if (parts.Length != 5 ||
                parts[0] != "1" ||
                parts[1] != databaseId ||
                parts[2] != metric.ToString() ||
                !int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out var tokenPageSize) ||
                tokenPageSize != pageSize ||
                !int.TryParse(parts[4], NumberStyles.None, CultureInfo.InvariantCulture, out var offset) ||
                offset < 0)
                throw new DatabaseCityPageTokenException();
            return offset;
        }
        catch (FormatException)
        {
            throw new DatabaseCityPageTokenException();
        }
        catch (DecoderFallbackException)
        {
            throw new DatabaseCityPageTokenException();
        }
    }
}
