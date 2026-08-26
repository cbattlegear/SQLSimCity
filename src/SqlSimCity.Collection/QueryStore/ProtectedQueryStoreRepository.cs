using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Numerics;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Storage;

namespace SqlSimCity.Collection.QueryStore;

public sealed class ProtectedQueryStoreRepository(IProtectedRecordStore store)
{
    private static readonly ProtectedRecordId CurrentPointerId = new("qs:current-snapshot-pointer");
    private const int IndexPageSize = 200;

    private readonly IProtectedRecordReadSession? _session;

    private ProtectedQueryStoreRepository(
        IProtectedRecordStore store, IProtectedRecordReadSession session)
        : this(store) => _session = session;

    /// <summary>
    /// Runs <paramref name="body"/> against a repository whose point reads are served from
    /// one storage connection rather than one per record, and closes that connection when it
    /// returns. Reads that span the batch still see writes committed by other connections,
    /// because the session never holds an open transaction between statements.
    /// The repository passed to the body is the one to read through; reads issued on the
    /// outer instance bypass the session and keep paying per-record connection setup.
    /// </summary>
    public async Task<T> ReadBatchAsync<T>(
        Func<ProtectedQueryStoreRepository, CancellationToken, Task<T>> body,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(body);
        if (_session is not null)
            return await body(this, cancellationToken).ConfigureAwait(false);
        await using var session = await store.BeginReadSessionAsync(cancellationToken).ConfigureAwait(false);
        return await body(
            new ProtectedQueryStoreRepository(store, session), cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc cref="ReadBatchAsync{T}(Func{ProtectedQueryStoreRepository, CancellationToken, Task{T}}, CancellationToken)"/>
    public Task ReadBatchAsync(
        Func<ProtectedQueryStoreRepository, CancellationToken, Task> body,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(body);
        return ReadBatchAsync<object?>(
            async (batch, token) =>
            {
                await body(batch, token).ConfigureAwait(false);
                return null;
            },
            cancellationToken);
    }

    private Task<ProtectedRecord?> GetRecordAsync(
        ProtectedRecordId id, CancellationToken cancellationToken) =>
        _session is null
            ? store.GetAsync(id, cancellationToken)
            : _session.GetAsync(id, cancellationToken);

    public Task StoreQueryTextAsync(
        string databaseId, string queryTextId, DateTimeOffset capturedAt, string queryText,
        CancellationToken cancellationToken = default) =>
        PutUtf8Async(Id("query-text", databaseId, queryTextId), "query-store-query-text",
            capturedAt, queryText, StorageResolution.Detail, cancellationToken);

    public Task StorePlanXmlAsync(
        string databaseId, string planId, DateTimeOffset capturedAt, string showplanXml,
        CancellationToken cancellationToken = default) =>
        PutUtf8Async(Id("showplan", databaseId, planId), "query-store-showplan",
            capturedAt, showplanXml, StorageResolution.Detail, cancellationToken);

    public async Task StoreNormalizedPlanAsync(
        NormalizedShowplanV1 plan, DateTimeOffset capturedAt,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var prefix = NormalizedPlanPrefix(plan.PlanId);
        await store.ReplaceSetAsync(
            prefix,
            BuildNormalizedPlanRecords(plan, capturedAt, prefix),
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Reads one normalized plan. A chunked plan is a manifest plus N chunk records, and a
    /// cold database-city page reads up to 96 plans, so the reads share one connection. When
    /// the caller is already inside <see cref="ReadBatchAsync{T}"/> this joins that batch
    /// instead of opening a second connection.
    /// </summary>
    public Task<NormalizedShowplanV1?> ReadNormalizedPlanAsync(
        string planId, CancellationToken cancellationToken = default) =>
        ReadBatchAsync(
            (batch, token) => batch.ReadNormalizedPlanCoreAsync(planId, token),
            cancellationToken);

    private async Task<NormalizedShowplanV1?> ReadNormalizedPlanCoreAsync(
        string planId, CancellationToken cancellationToken)
    {
        var prefix = NormalizedPlanPrefix(planId);
        using var record = await GetRecordAsync(
            new ProtectedRecordId($"{prefix}manifest"), cancellationToken).ConfigureAwait(false);
        if (record is null)
            return await ReadJsonAsync<NormalizedShowplanV1>(
                Id("normalized-plan", planId, "current"), cancellationToken).ConfigureAwait(false);
        using var document = JsonDocument.Parse(record.Payload);
        if (!document.RootElement.TryGetProperty(nameof(QueryStoreChunkManifest.ChunkCount), out var count))
            return JsonSerializer.Deserialize<NormalizedShowplanV1>(record.Payload.Span);
        var bytes = await ReadNamedChunksAsync(
            prefix, count.GetInt32(), cancellationToken).ConfigureAwait(false);
        try
        {
            return JsonSerializer.Deserialize<NormalizedShowplanV1>(bytes);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    public Task StoreTextDescriptorAsync(
        string databaseId, string queryTextId, QueryTextDescriptorV1 descriptor,
        DateTimeOffset capturedAt, CancellationToken cancellationToken = default) =>
        PutJsonAsync(Id("text-descriptor", databaseId, queryTextId),
            "query-store-text-descriptor", capturedAt, StorageResolution.Detail, descriptor, cancellationToken);

    public Task<QueryTextDescriptorV1?> ReadTextDescriptorAsync(
        string databaseId, string queryTextId, CancellationToken cancellationToken = default) =>
        ReadJsonAsync<QueryTextDescriptorV1>(Id("text-descriptor", databaseId, queryTextId), cancellationToken);

    public Task StoreNormalizedFactAsync<T>(
        string databaseId, string factId, DateTimeOffset capturedAt,
        StorageResolution resolution, T value, CancellationToken cancellationToken = default) =>
        PutJsonAsync(Id("fact", databaseId, factId), "query-store-normalized-fact",
            capturedAt, resolution, value, cancellationToken);

    public async Task PublishSnapshotAsync(
        QueryStorePublishedSnapshot snapshot,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        var current = await ReadJsonAsync<QueryStoreSnapshotPointer>(
            CurrentPointerId, cancellationToken).ConfigureAwait(false);
        var slot = current?.StorageSlot == "0" ? "1" : "0";
        var indexSets = new List<QueryStoreIndexSet>();
        var snapshotRecordId = SlotId(slot, "snapshot", "header");
        await store.ReplaceSetAsync(
            SlotPrefix(slot),
            BuildSlotRecords(snapshot, slot, snapshotRecordId, indexSets),
            cancellationToken).ConfigureAwait(false);
        await PutJsonAsync(CurrentPointerId, "query-store-snapshot-pointer", snapshot.PublishedAt,
            StorageResolution.HourlyRollup,
            new QueryStoreSnapshotPointer(snapshotRecordId.Value, slot),
            cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Reads the current published snapshot in full. The pointer, header, index pages and
    /// families are hundreds of point reads, so they share one storage connection.
    /// </summary>
    public Task<QueryStorePublishedSnapshot?> ReadPublishedSnapshotAsync(
        CancellationToken cancellationToken = default) =>
        ReadBatchAsync(
            static (batch, token) => batch.ReadPublishedSnapshotCoreAsync(token),
            cancellationToken);

    private async Task<QueryStorePublishedSnapshot?> ReadPublishedSnapshotCoreAsync(
        CancellationToken cancellationToken)
    {
        var pointer = await ReadJsonAsync<QueryStoreSnapshotPointer>(
            CurrentPointerId, cancellationToken).ConfigureAwait(false);
        if (pointer is null) return null;
        var snapshot = await ReadJsonAsync<QueryStorePublishedSnapshot>(
            new ProtectedRecordId(pointer.SnapshotRecordId), cancellationToken).ConfigureAwait(false);
        return snapshot is null
            ? null
            : await ReadPublishedSnapshotAsync(snapshot, cancellationToken).ConfigureAwait(false);
    }

    public async Task<QueryStorePublishedSnapshot> ReadPublishedSnapshotAsync(
        QueryStorePublishedSnapshot snapshot,
        CancellationToken cancellationToken = default)
    {
        if (snapshot.IndexSets is not null)
        {
            var index = snapshot.IndexSets.Single(item => item.Metric == "execution" && item.DatabaseId is null);
            var indexedFamilies = new List<QueryFamilyDetailV1>(index.TotalCount);
            for (var page = 0; page < index.PageCount; page++)
            {
                var ids = await ReadIndexPageAsync(
                    snapshot, index.Metric, null, page, cancellationToken).ConfigureAwait(false) ??
                    throw new InvalidDataException("A protected Query Store index page is missing.");
                foreach (var familyId in ids.FamilyIds)
                    indexedFamilies.Add(await ReadFamilyAsync(
                        snapshot, familyId, cancellationToken).ConfigureAwait(false) ??
                        throw new InvalidDataException("A protected Query Store family is missing."));
            }
            return snapshot with { Families = indexedFamilies };
        }
        if (snapshot.FamilyChunkRecordIds is null) return snapshot;
        var families = new List<QueryFamilyDetailV1>();
        foreach (var chunkId in snapshot.FamilyChunkRecordIds)
        {
            var chunk = await ReadJsonAsync<QueryStoreFamilyChunk>(
                new ProtectedRecordId(chunkId), cancellationToken).ConfigureAwait(false) ??
                throw new InvalidDataException("A protected Query Store snapshot family chunk is missing.");
            families.AddRange(chunk.Families);
        }
        return snapshot with { Families = families };
    }

    public async Task<QueryStorePublishedSnapshot?> ReadPublishedSnapshotHeaderAsync(
        CancellationToken cancellationToken = default)
    {
        var pointer = await ReadJsonAsync<QueryStoreSnapshotPointer>(
            CurrentPointerId, cancellationToken).ConfigureAwait(false);
        return pointer is null ? null : await ReadJsonAsync<QueryStorePublishedSnapshot>(
            new ProtectedRecordId(pointer.SnapshotRecordId), cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Reads through a published snapshot, retrying if the snapshot is replaced underneath
    /// the read. The whole read runs on one storage connection; <paramref name="reader"/>
    /// receives the repository bound to it and must read through that instance.
    /// </summary>
    public Task<T> ReadConsistentPublishedSnapshotAsync<T>(
        Func<ProtectedQueryStoreRepository, QueryStorePublishedSnapshot?, CancellationToken, Task<T>> reader,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(reader);
        return ReadBatchAsync(
            (batch, token) => batch.ReadConsistentPublishedSnapshotCoreAsync(reader, token),
            cancellationToken);
    }

    private async Task<T> ReadConsistentPublishedSnapshotCoreAsync<T>(
        Func<ProtectedQueryStoreRepository, QueryStorePublishedSnapshot?, CancellationToken, Task<T>> reader,
        CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var before = await ReadPublishedSnapshotHeaderAsync(cancellationToken).ConfigureAwait(false);
            T result;
            try
            {
                result = await reader(this, before, cancellationToken).ConfigureAwait(false);
            }
            catch (InvalidDataException)
            {
                var afterFailure = await ReadPublishedSnapshotHeaderAsync(cancellationToken)
                    .ConfigureAwait(false);
                if (SameSnapshot(before, afterFailure)) throw;
                if (attempt == 0) continue;
                throw new QueryStoreSnapshotChangedException();
            }

            // Legacy snapshots use immutable GUID-derived records rather than reusable slots.
            if (before is { StorageSlot: null }) return result;
            var after = await ReadPublishedSnapshotHeaderAsync(cancellationToken).ConfigureAwait(false);
            if (SameSnapshot(before, after)) return result;
            if (attempt == 1) throw new QueryStoreSnapshotChangedException();
        }
        throw new QueryStoreSnapshotChangedException();
    }

    public Task<QueryFamilyDetailV1?> ReadFamilyAsync(
        string snapshotId, string familyId, CancellationToken cancellationToken = default) =>
        ReadFamilyForSnapshotIdAsync(snapshotId, familyId, cancellationToken);

    public async Task<QueryFamilyDetailV1?> ReadFamilyAsync(
        QueryStorePublishedSnapshot snapshot,
        string familyId,
        CancellationToken cancellationToken = default)
    {
        if (snapshot.StorageSlot is null)
            return await ReadJsonAsync<QueryFamilyDetailV1>(
                LegacyFamilyId(snapshot.SnapshotId, familyId), cancellationToken).ConfigureAwait(false);
        var stored = await ReadJsonAsync<QueryStoreStoredFamily>(
            SlotFamilyId(snapshot.StorageSlot, familyId), cancellationToken).ConfigureAwait(false);
        if (stored is null) return null;
        if (stored.InlineDetail is not null) return stored.InlineDetail;
        var bytes = await ReadChunksAsync(
            snapshot.StorageSlot, familyId, "detail", stored.DetailChunkCount, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            return JsonSerializer.Deserialize<QueryFamilyDetailV1>(bytes);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    public async Task<QueryFamilySummaryV1?> ReadFamilySummaryAsync(
        QueryStorePublishedSnapshot snapshot,
        string familyId,
        CancellationToken cancellationToken = default)
    {
        if (snapshot.StorageSlot is null)
            return (await ReadFamilyAsync(snapshot, familyId, cancellationToken).ConfigureAwait(false))?.Family;
        var stored = await ReadJsonAsync<QueryStoreStoredFamily>(
            SlotFamilyId(snapshot.StorageSlot, familyId), cancellationToken).ConfigureAwait(false);
        if (stored is null) return null;
        if (stored.InlineSummary is not null) return stored.InlineSummary;
        var bytes = await ReadChunksAsync(
            snapshot.StorageSlot, familyId, "summary", stored.SummaryChunkCount, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            return JsonSerializer.Deserialize<QueryFamilySummaryV1>(bytes);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    public Task<QueryStoreIndexPage?> ReadIndexPageAsync(
        string snapshotId, string metric, string? databaseId, int page,
        CancellationToken cancellationToken = default) =>
        ReadJsonAsync<QueryStoreIndexPage>(
            LegacyIndexId(snapshotId, metric, databaseId, page), cancellationToken);

    public Task<QueryStoreIndexPage?> ReadIndexPageAsync(
        QueryStorePublishedSnapshot snapshot,
        string metric,
        string? databaseId,
        int page,
        CancellationToken cancellationToken = default) =>
        ReadJsonAsync<QueryStoreIndexPage>(
            snapshot.StorageSlot is null
                ? LegacyIndexId(snapshot.SnapshotId, metric, databaseId, page)
                : SlotIndexId(snapshot.StorageSlot, metric, databaseId, page),
            cancellationToken);

    public Task StoreWatermarkAsync(
        QueryStoreWatermark watermark,
        CancellationToken cancellationToken = default) =>
        PutJsonAsync(Id("watermark", watermark.DatabaseId, "current"),
            "query-store-watermark", watermark.Through, StorageResolution.Detail, watermark, cancellationToken);

    public Task<QueryStoreWatermark?> ReadWatermarkAsync(
        string databaseId,
        CancellationToken cancellationToken = default) =>
        ReadJsonAsync<QueryStoreWatermark>(Id("watermark", databaseId, "current"), cancellationToken);

    public Task<bool> DeleteWatermarkAsync(
        string databaseId,
        CancellationToken cancellationToken = default) =>
        store.DeleteAsync(Id("watermark", databaseId, "current"), cancellationToken);

    public async Task<string?> ReadSensitiveTextAsync(
        string kind, string databaseId, string sourceId,
        CancellationToken cancellationToken = default)
    {
        if (kind is not ("query-text" or "showplan")) throw new ArgumentOutOfRangeException(nameof(kind));
        using var record = await GetRecordAsync(
            Id(kind, databaseId, sourceId), cancellationToken).ConfigureAwait(false);
        return record is null ? null : Encoding.UTF8.GetString(record.Payload.Span);
    }

    private async Task PutUtf8Async(
        ProtectedRecordId id, string recordKind, DateTimeOffset capturedAt, string value,
        StorageResolution resolution, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(value);
        var bytes = Encoding.UTF8.GetBytes(value);
        try
        {
            await store.PutAsync(id, recordKind, capturedAt, resolution, bytes, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private async Task PutJsonAsync<T>(
        ProtectedRecordId id, string recordKind, DateTimeOffset capturedAt,
        StorageResolution resolution, T value, CancellationToken cancellationToken)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        try
        {
            await store.PutAsync(id, recordKind, capturedAt, resolution, bytes, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private async Task<T?> ReadJsonAsync<T>(
        ProtectedRecordId id,
        CancellationToken cancellationToken)
    {
        using var record = await GetRecordAsync(id, cancellationToken).ConfigureAwait(false);
        return record is null ? default : JsonSerializer.Deserialize<T>(record.Payload.Span);
    }

    private IEnumerable<ProtectedRecordWrite> BuildSlotRecords(
        QueryStorePublishedSnapshot snapshot,
        string slot,
        ProtectedRecordId snapshotRecordId,
        List<QueryStoreIndexSet> indexSets)
    {
        foreach (var family in snapshot.Families)
        foreach (var record in BuildFamilyRecords(slot, family, snapshot.PublishedAt))
            yield return record;

        var databaseIds = snapshot.Families.Select(item => item.Family.DatabaseId)
            .Distinct(StringComparer.Ordinal).Cast<string?>().Append(null).ToArray();
        foreach (var metric in QueryStoreMetrics)
        foreach (var databaseId in databaseIds)
        {
            var ordered = snapshot.Families
                .Where(item => databaseId is null || item.Family.DatabaseId == databaseId)
                .OrderByDescending(item => Metric(item.Family, metric))
                .ThenBy(item => item.Family.FamilyId, StringComparer.Ordinal)
                .Select(item => item.Family.FamilyId).ToArray();
            var pageCount = (ordered.Length + IndexPageSize - 1) / IndexPageSize;
            for (var page = 0; page < pageCount; page++)
            {
                var value = new QueryStoreIndexPage(
                    ordered.Skip(page * IndexPageSize).Take(IndexPageSize).ToArray());
                foreach (var record in JsonWrites(
                             SlotIndexId(slot, metric, databaseId, page),
                             "query-store-family-index-page",
                             snapshot.PublishedAt,
                             value,
                             StorageResolution.HourlyRollup))
                    yield return record;
            }
            indexSets.Add(new QueryStoreIndexSet(metric, databaseId, ordered.Length, pageCount));
        }

        var header = snapshot with
        {
            Families = [],
            FamilyChunkRecordIds = null,
            IndexSets = indexSets.ToArray(),
            StorageSlot = slot,
        };
        foreach (var record in JsonWrites(
                     snapshotRecordId, "query-store-published-snapshot", snapshot.PublishedAt, header,
                     StorageResolution.HourlyRollup))
            yield return record;
    }

    private IEnumerable<ProtectedRecordWrite> BuildNormalizedPlanRecords(
        NormalizedShowplanV1 plan,
        DateTimeOffset capturedAt,
        string prefix)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(plan);
        try
        {
            if (bytes.Length <= store.MaxPayloadBytes)
            {
                yield return BytesWrite(
                    new ProtectedRecordId($"{prefix}manifest"),
                    "query-store-normalized-plan", capturedAt, bytes);
                yield break;
            }

            var chunkCount = ChunkCount(bytes.Length, store.MaxPayloadBytes);
            foreach (var record in JsonWrites(
                         new ProtectedRecordId($"{prefix}manifest"),
                         "query-store-normalized-plan",
                         capturedAt,
                         new QueryStoreChunkManifest(chunkCount)))
                yield return record;
            for (var offset = 0; offset < bytes.Length; offset += store.MaxPayloadBytes)
            {
                var count = Math.Min(store.MaxPayloadBytes, bytes.Length - offset);
                var chunk = bytes.AsSpan(offset, count).ToArray();
                try
                {
                    yield return BytesWrite(
                        new ProtectedRecordId(
                            $"{prefix}chunk:{offset / store.MaxPayloadBytes}"),
                        "query-store-normalized-plan-chunk", capturedAt, chunk);
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(chunk);
                }
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private IEnumerable<ProtectedRecordWrite> BuildFamilyRecords(
        string slot,
        QueryFamilyDetailV1 family,
        DateTimeOffset capturedAt)
    {
        var inline = new QueryStoreStoredFamily(family.Family, family, 0, 0);
        var inlineBytes = JsonSerializer.SerializeToUtf8Bytes(inline);
        if (inlineBytes.Length <= store.MaxPayloadBytes)
        {
            try
            {
                yield return BytesWrite(
                    SlotFamilyId(slot, family.Family.FamilyId),
                    "query-store-family-detail", capturedAt, inlineBytes,
                    StorageResolution.HourlyRollup);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(inlineBytes);
            }
            yield break;
        }
        CryptographicOperations.ZeroMemory(inlineBytes);

        var detailBytes = JsonSerializer.SerializeToUtf8Bytes(family);
        var detailChunks = ChunkCount(detailBytes.Length, store.MaxPayloadBytes);
        var summaryBytes = JsonSerializer.SerializeToUtf8Bytes(family.Family);
        var summaryInline = new QueryStoreStoredFamily(family.Family, null, 0, detailChunks);
        var manifestBytes = JsonSerializer.SerializeToUtf8Bytes(summaryInline);
        var summaryChunks = 0;
        if (manifestBytes.Length > store.MaxPayloadBytes)
        {
            CryptographicOperations.ZeroMemory(manifestBytes);
            summaryChunks = ChunkCount(summaryBytes.Length, store.MaxPayloadBytes);
            manifestBytes = JsonSerializer.SerializeToUtf8Bytes(
                new QueryStoreStoredFamily(null, null, summaryChunks, detailChunks));
        }
        try
        {
            if (manifestBytes.Length > store.MaxPayloadBytes)
                throw new InvalidDataException("The protected Query Store family manifest exceeds the record limit.");
            yield return BytesWrite(
                SlotFamilyId(slot, family.Family.FamilyId),
                "query-store-family-detail", capturedAt, manifestBytes,
                StorageResolution.HourlyRollup);
            if (summaryChunks > 0)
                foreach (var record in ChunkWrites(
                             slot, family.Family.FamilyId, "summary", summaryBytes, capturedAt))
                    yield return record;
            foreach (var record in ChunkWrites(
                         slot, family.Family.FamilyId, "detail", detailBytes, capturedAt))
                yield return record;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(manifestBytes);
            CryptographicOperations.ZeroMemory(summaryBytes);
            CryptographicOperations.ZeroMemory(detailBytes);
        }
    }

    private IEnumerable<ProtectedRecordWrite> ChunkWrites(
        string slot,
        string familyId,
        string component,
        byte[] bytes,
        DateTimeOffset capturedAt)
    {
        for (var offset = 0; offset < bytes.Length; offset += store.MaxPayloadBytes)
        {
            var count = Math.Min(store.MaxPayloadBytes, bytes.Length - offset);
            var chunk = bytes.AsSpan(offset, count).ToArray();
            try
            {
                yield return BytesWrite(
                    SlotChunkId(slot, familyId, component, offset / store.MaxPayloadBytes),
                    $"query-store-family-{component}-chunk", capturedAt, chunk,
                    StorageResolution.HourlyRollup);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(chunk);
            }
        }
    }

    private async Task<byte[]> ReadChunksAsync(
        string slot,
        string familyId,
        string component,
        int chunkCount,
        CancellationToken cancellationToken)
    {
        if (chunkCount <= 0)
            throw new InvalidDataException("A chunked protected Query Store family has no chunks.");
        using var buffer = new MemoryStream();
        for (var index = 0; index < chunkCount; index++)
        {
            using var record = await GetRecordAsync(
                SlotChunkId(slot, familyId, component, index), cancellationToken).ConfigureAwait(false) ??
                throw new InvalidDataException("A protected Query Store family chunk is missing.");
            await buffer.WriteAsync(record.Payload, cancellationToken).ConfigureAwait(false);
        }
        return buffer.ToArray();
    }

    private async Task<byte[]> ReadNamedChunksAsync(
        string prefix,
        int chunkCount,
        CancellationToken cancellationToken)
    {
        if (chunkCount <= 0)
            throw new InvalidDataException("A chunked protected Query Store plan has no chunks.");
        using var buffer = new MemoryStream();
        for (var index = 0; index < chunkCount; index++)
        {
            using var record = await GetRecordAsync(
                new ProtectedRecordId($"{prefix}chunk:{index}"), cancellationToken).ConfigureAwait(false) ??
                throw new InvalidDataException("A protected Query Store plan chunk is missing.");
            await buffer.WriteAsync(record.Payload, cancellationToken).ConfigureAwait(false);
        }
        return buffer.ToArray();
    }

    private async Task<QueryFamilyDetailV1?> ReadFamilyForSnapshotIdAsync(
        string snapshotId,
        string familyId,
        CancellationToken cancellationToken)
    {
        var current = await ReadPublishedSnapshotHeaderAsync(cancellationToken).ConfigureAwait(false);
        if (current is not null &&
            string.Equals(current.SnapshotId, snapshotId, StringComparison.Ordinal))
            return await ReadFamilyAsync(current, familyId, cancellationToken).ConfigureAwait(false);
        return await ReadJsonAsync<QueryFamilyDetailV1>(
            LegacyFamilyId(snapshotId, familyId), cancellationToken).ConfigureAwait(false);
    }

    private static int ChunkCount(int length, int chunkSize) =>
        checked((length + chunkSize - 1) / chunkSize);

    private static IEnumerable<ProtectedRecordWrite> JsonWrites<T>(
        ProtectedRecordId id,
        string recordKind,
        DateTimeOffset capturedAt,
        T value,
        StorageResolution resolution = StorageResolution.Detail)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        try
        {
            yield return BytesWrite(id, recordKind, capturedAt, bytes, resolution);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private static ProtectedRecordWrite BytesWrite(
        ProtectedRecordId id,
        string recordKind,
        DateTimeOffset capturedAt,
        byte[] bytes,
        StorageResolution resolution = StorageResolution.Detail) =>
        new(id, recordKind, capturedAt, resolution, bytes);

    private static bool SameSnapshot(
        QueryStorePublishedSnapshot? left,
        QueryStorePublishedSnapshot? right) =>
        left is null && right is null ||
        left is not null && right is not null &&
        left.Sequence == right.Sequence &&
        string.Equals(left.SnapshotId, right.SnapshotId, StringComparison.Ordinal) &&
        string.Equals(left.StorageSlot, right.StorageSlot, StringComparison.Ordinal);

    private static ProtectedRecordId Id(string kind, string databaseId, string sourceId)
    {
        var opaque = SHA256.HashData(Encoding.UTF8.GetBytes($"{kind}\n{databaseId}\n{sourceId}"));
        return new ProtectedRecordId($"qs:{Convert.ToHexString(opaque).ToLowerInvariant()}");
    }

    private static ProtectedRecordId LegacyFamilyId(string snapshotId, string familyId) =>
        Id("family-detail", snapshotId, familyId);
    private static ProtectedRecordId LegacyIndexId(
        string snapshotId, string metric, string? databaseId, int page) =>
        Id($"family-index:{metric}", snapshotId,
            $"{databaseId ?? "*"}\n{page.ToString(CultureInfo.InvariantCulture)}");
    private static string SlotPrefix(string slot) => $"qs:query-store-slot:{slot}:";
    private static string NormalizedPlanPrefix(string planId)
    {
        var opaque = SHA256.HashData(Encoding.UTF8.GetBytes(planId));
        return $"qs:normalized-plan:{Convert.ToHexString(opaque).ToLowerInvariant()}:";
    }
    private static ProtectedRecordId SlotId(string slot, string kind, string source)
    {
        var opaque = SHA256.HashData(Encoding.UTF8.GetBytes($"{kind}\n{source}"));
        return new ProtectedRecordId($"{SlotPrefix(slot)}{Convert.ToHexString(opaque).ToLowerInvariant()}");
    }
    private static ProtectedRecordId SlotFamilyId(string slot, string familyId) =>
        SlotId(slot, "family", familyId);
    private static ProtectedRecordId SlotChunkId(
        string slot, string familyId, string component, int chunk) =>
        SlotId(slot, $"family-{component}-chunk", $"{familyId}\n{chunk.ToString(CultureInfo.InvariantCulture)}");
    private static ProtectedRecordId SlotIndexId(
        string slot, string metric, string? databaseId, int page) =>
        SlotId(slot, $"family-index:{metric}",
            $"{databaseId ?? "*"}\n{page.ToString(CultureInfo.InvariantCulture)}");

    private static readonly string[] QueryStoreMetrics =
        ["execution", "cpu", "duration", "reads", "waits"];
    private static ExactNumber Metric(QueryFamilySummaryV1 family, string metric) =>
        ExactNumber.Parse(metric switch
        {
            "execution" => family.ExecutionCount,
            "duration" => family.TotalDurationMicroseconds,
            "reads" => family.TotalLogicalReads8KiBPages,
            "waits" => family.TotalWaitMilliseconds,
            _ => family.TotalCpuMicroseconds,
        });

    private readonly record struct ExactNumber(BigInteger Unscaled, int Scale) : IComparable<ExactNumber>
    {
        public static ExactNumber Parse(string value)
        {
            var span = value.AsSpan();
            var negative = span.Length > 0 && span[0] == '-';
            if (negative) span = span[1..];
            var point = span.IndexOf('.');
            var scale = point < 0 ? 0 : span.Length - point - 1;
            var digits = point < 0 ? span.ToString() : string.Concat(span[..point], span[(point + 1)..]);
            var unscaled = BigInteger.Parse(digits, CultureInfo.InvariantCulture);
            return new(negative ? -unscaled : unscaled, scale);
        }
        public int CompareTo(ExactNumber other)
        {
            var scale = Math.Max(Scale, other.Scale);
            return (Unscaled * BigInteger.Pow(10, scale - Scale))
                .CompareTo(other.Unscaled * BigInteger.Pow(10, scale - other.Scale));
        }
    }
}

public sealed record QueryStoreSnapshotPointer(string SnapshotRecordId, string? StorageSlot = null);

public sealed record QueryStorePublishedSnapshot(
    string SchemaVersion,
    string SnapshotId,
    long Sequence,
    DateTimeOffset PublishedAt,
    IReadOnlyList<QueryFamilyDetailV1> Families,
    QueryStoreCollectorStatusV1 Status,
    IReadOnlyList<string>? FamilyChunkRecordIds = null,
    IReadOnlyList<QueryStoreIndexSet>? IndexSets = null,
    string? StorageSlot = null);

public sealed record QueryStoreFamilyChunk(IReadOnlyList<QueryFamilyDetailV1> Families);
public sealed record QueryStoreStoredFamily(
    QueryFamilySummaryV1? InlineSummary,
    QueryFamilyDetailV1? InlineDetail,
    int SummaryChunkCount,
    int DetailChunkCount);
public sealed record QueryStoreChunkManifest(int ChunkCount);
public sealed record QueryStoreIndexSet(
    string Metric, string? DatabaseId, int TotalCount, int PageCount);
public sealed record QueryStoreIndexPage(IReadOnlyList<string> FamilyIds);

public sealed class QueryStoreSnapshotChangedException()
    : Exception("The published Query Store snapshot changed repeatedly during the read.");
