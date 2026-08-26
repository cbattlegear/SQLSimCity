using System.IO.Compression;
using System.Text;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Ingestion;

namespace SqlSimCity.Edge.Tests;

public sealed class IngestionTests
{
    private static readonly IngestionLimits Limits = new();
    private static ObservationFreshnessV1 Fresh => new(DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, null);

    private static ObservationEnvelopeV1 Chunk(
        byte[] content,
        ObservationCompression compression = ObservationCompression.None,
        string connectorId = "c",
        string targetId = "t",
        long sequence = 1,
        string epoch = "e1",
        string groupId = "g1",
        int index = 0,
        int count = 1,
        ObservationSection section = ObservationSection.Atlas)
        => new(
            "1.0", connectorId, targetId, sequence, epoch, "boot", DateTimeOffset.UnixEpoch,
            section, groupId, index, count, compression, EdgeJson.Sha256Hex(content), Fresh,
            Convert.ToBase64String(content));

    private static ObservationBatchV1 Batch(string connectorId, string batchId, params ObservationEnvelopeV1[] envelopes)
        => new("1.0", connectorId, batchId, ObservationBatchBuilder.DeriveIdempotencyKey(connectorId, envelopes),
            DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, envelopes);

    private static byte[] Json(string s) => Encoding.UTF8.GetBytes(s);

    private static byte[] Gzip(byte[] raw)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
            gzip.Write(raw, 0, raw.Length);
        return output.ToArray();
    }

    [Fact]
    public void Valid_batch_is_accepted_and_section_published()
    {
        var store = new EdgeObservationStore();
        var batch = Batch("c", "b1", Chunk(Json("{\"v\":1}")));

        Assert.True(EdgeBatchValidator.TryValidate(batch, Limits, out var chunks, out _));
        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(batch, chunks).Outcome);

        var section = store.GetSection("t", ObservationSection.Atlas);
        Assert.NotNull(section);
        Assert.Equal("{\"v\":1}", Encoding.UTF8.GetString(section!.Content));
    }

    [Fact]
    public void Digest_mismatch_is_rejected()
    {
        var tampered = Chunk(Json("{\"v\":1}")) with { ContentDigest = new string('0', 64) };
        var batch = Batch("c", "b1", tampered);
        Assert.False(EdgeBatchValidator.TryValidate(batch, Limits, out _, out var result));
        Assert.Equal(IngestionOutcome.Rejected, result.Outcome);
    }

    [Fact]
    public void Null_envelope_element_is_rejected_without_throwing()
    {
        var batch = new ObservationBatchV1(
            "1.0", "c", "b1", new string('a', 64),
            DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, [null!]);

        Assert.False(EdgeBatchValidator.TryValidate(batch, Limits, out _, out var result));
        Assert.Equal(IngestionOutcome.Rejected, result.Outcome);
    }

    [Fact]
    public void Oversized_chunk_is_rejected()
    {
        var limits = new IngestionLimits { MaxChunkPayloadBytes = 16 };
        var batch = Batch("c", "b1", Chunk(Json("{\"v\":\"aaaaaaaaaaaaaaaaaaaaaaaa\"}")));
        Assert.False(EdgeBatchValidator.TryValidate(batch, limits, out _, out var result));
        Assert.Equal(IngestionOutcome.Rejected, result.Outcome);
    }

    [Fact]
    public void Compression_bomb_is_rejected()
    {
        var raw = new byte[2_000_000]; // 2 MB of zeros compresses tiny
        var compressed = Gzip(raw);
        var limits = new IngestionLimits { MaxDecompressedChunkBytes = 64 * 1024, MaxDecompressionRatio = 1000 };
        var batch = Batch("c", "b1", Chunk(compressed, ObservationCompression.Gzip));

        Assert.False(EdgeBatchValidator.TryValidate(batch, limits, out _, out var result));
        Assert.Equal(IngestionOutcome.Rejected, result.Outcome);
    }

    [Fact]
    public void Duplicate_batch_is_idempotent()
    {
        var store = new EdgeObservationStore();
        var batch = Batch("c", "b1", Chunk(Json("{\"v\":1}")));
        EdgeBatchValidator.TryValidate(batch, Limits, out var chunks, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(batch, chunks).Outcome);
        Assert.Equal(IngestionOutcome.DuplicateAccepted, store.Ingest(batch, chunks).Outcome);
    }

    [Fact]
    public void Batch_id_reuse_with_different_content_conflicts()
    {
        var store = new EdgeObservationStore();
        var first = Batch("c", "reused", Chunk(Json("{\"v\":1}"), sequence: 1));
        var second = Batch("c", "reused", Chunk(Json("{\"v\":2}"), sequence: 2));
        EdgeBatchValidator.TryValidate(first, Limits, out var c1, out _);
        EdgeBatchValidator.TryValidate(second, Limits, out var c2, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(first, c1).Outcome);
        Assert.Equal(IngestionOutcome.Conflict, store.Ingest(second, c2).Outcome);
    }

    [Fact]
    public void Sequence_rollback_conflicts()
    {
        var store = new EdgeObservationStore();
        var higher = Batch("c", "b2", Chunk(Json("{\"v\":2}"), sequence: 5));
        var lower = Batch("c", "b1", Chunk(Json("{\"v\":1}"), sequence: 3));
        EdgeBatchValidator.TryValidate(higher, Limits, out var ch, out _);
        EdgeBatchValidator.TryValidate(lower, Limits, out var cl, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(higher, ch).Outcome);
        Assert.Equal(IngestionOutcome.Conflict, store.Ingest(lower, cl).Outcome);
    }

    [Fact]
    public void New_epoch_resets_sequence_baseline()
    {
        var store = new EdgeObservationStore();
        var high = Batch("c", "b1", Chunk(Json("{\"v\":9}"), sequence: 9, epoch: "e1"));
        var newEpoch = Batch("c", "b2", Chunk(Json("{\"v\":0}"), sequence: 0, epoch: "e2"));
        EdgeBatchValidator.TryValidate(high, Limits, out var c1, out _);
        EdgeBatchValidator.TryValidate(newEpoch, Limits, out var c2, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(high, c1).Outcome);
        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(newEpoch, c2).Outcome);
        Assert.Equal("e2", store.GetSection("t", ObservationSection.Atlas)!.EpochId);
    }

    [Fact]
    public void Retired_epoch_replay_conflicts()
    {
        var store = new EdgeObservationStore();
        var e1 = Batch("c", "b1", Chunk(Json("{\"v\":1}"), sequence: 1, epoch: "e1"));
        var e2 = Batch("c", "b2", Chunk(Json("{\"v\":2}"), sequence: 1, epoch: "e2"));
        var replayE1 = Batch("c", "b3", Chunk(Json("{\"v\":3}"), sequence: 2, epoch: "e1"));
        EdgeBatchValidator.TryValidate(e1, Limits, out var c1, out _);
        EdgeBatchValidator.TryValidate(e2, Limits, out var c2, out _);
        EdgeBatchValidator.TryValidate(replayE1, Limits, out var c3, out _);

        store.Ingest(e1, c1);
        store.Ingest(e2, c2);
        Assert.Equal(IngestionOutcome.Conflict, store.Ingest(replayE1, c3).Outcome);
    }

    [Fact]
    public void Target_owned_by_another_connector_conflicts()
    {
        var store = new EdgeObservationStore();
        var a = Batch("connector-a", "b1", Chunk(Json("{\"v\":1}"), connectorId: "connector-a", targetId: "shared"));
        var b = Batch("connector-b", "b2", Chunk(Json("{\"v\":2}"), connectorId: "connector-b", targetId: "shared", sequence: 2));
        EdgeBatchValidator.TryValidate(a, Limits, out var ca, out _);
        EdgeBatchValidator.TryValidate(b, Limits, out var cb, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(a, ca).Outcome);
        Assert.Equal(IngestionOutcome.Conflict, store.Ingest(b, cb).Outcome);
    }

    [Fact]
    public void Group_published_only_when_all_chunks_arrive_across_batches()
    {
        var store = new EdgeObservationStore();
        var part0 = Chunk(Json("HELLO"), groupId: "g", index: 0, count: 2, sequence: 1);
        var part1 = Chunk(Json("WORLD"), groupId: "g", index: 1, count: 2, sequence: 1);
        var b1 = Batch("c", "b1", part0);
        var b2 = Batch("c", "b2", part1);

        EdgeBatchValidator.TryValidate(b1, Limits, out var c1, out _);
        EdgeBatchValidator.TryValidate(b2, Limits, out var c2, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(b1, c1).Outcome);
        Assert.Null(store.GetSection("t", ObservationSection.Atlas)); // not yet complete

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(b2, c2).Outcome);
        var section = store.GetSection("t", ObservationSection.Atlas);
        Assert.NotNull(section);
        Assert.Equal("HELLOWORLD", Encoding.UTF8.GetString(section!.Content));
    }

    [Fact]
    public void Chunk_count_above_group_limit_is_rejected()
    {
        var limits = new IngestionLimits { MaxChunksPerGroup = 1 };
        var batch = Batch("c", "b1", Chunk(Json("{\"v\":1}"), index: 0, count: 2));
        Assert.False(EdgeBatchValidator.TryValidate(batch, limits, out _, out var result));
        Assert.Equal(IngestionOutcome.Rejected, result.Outcome);
    }

    [Fact]
    public void Section_exceeding_max_reassembled_size_is_rejected()
    {
        var store = new EdgeObservationStore(maxSectionBytes: 8);
        var batch = Batch("c", "b1", Chunk(Json("{\"value\":\"way too long\"}")));
        Assert.True(EdgeBatchValidator.TryValidate(batch, Limits, out var chunks, out _));
        Assert.Equal(IngestionOutcome.Rejected, store.Ingest(batch, chunks).Outcome);
        Assert.Null(store.GetSection("t", ObservationSection.Atlas));
    }

    [Fact]
    public void Late_oversize_rejection_leaves_no_target_or_owner()
    {
        var store = new EdgeObservationStore(maxSectionBytes: 8);
        var rejected = Batch(
            "connector-a",
            "rejected",
            Chunk(Json("{}"), connectorId: "connector-a", targetId: "unclaimed", section: ObservationSection.Atlas),
            Chunk(Json("123456789"), connectorId: "connector-a", targetId: "unclaimed",
                groupId: "g2", section: ObservationSection.Live));
        Assert.True(EdgeBatchValidator.TryValidate(rejected, Limits, out var rejectedChunks, out _));

        Assert.Equal(IngestionOutcome.Rejected, store.Ingest(rejected, rejectedChunks).Outcome);
        Assert.Empty(store.GetTargets());

        var accepted = Batch(
            "connector-b",
            "accepted",
            Chunk(Json("{}"), connectorId: "connector-b", targetId: "unclaimed"));
        EdgeBatchValidator.TryValidate(accepted, Limits, out var acceptedChunks, out _);
        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(accepted, acceptedChunks).Outcome);
        Assert.Equal("connector-b", Assert.Single(store.GetTargets()).ConnectorId);
    }

    [Fact]
    public void Conflicting_second_chunk_rejects_without_consuming_it()
    {
        var store = new EdgeObservationStore(maxSectionBytes: 16);
        var first = Batch("c", "first", Chunk(Json("HELLO"), groupId: "g", index: 0, count: 2));
        var conflict = Batch("c", "conflict", Chunk(Json("ODD"), groupId: "g", index: 1, count: 3));
        var second = Batch("c", "second", Chunk(Json("WORLD"), groupId: "g", index: 1, count: 2));
        EdgeBatchValidator.TryValidate(first, Limits, out var firstChunks, out _);
        EdgeBatchValidator.TryValidate(conflict, Limits, out var conflictingChunks, out _);
        EdgeBatchValidator.TryValidate(second, Limits, out var secondChunks, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(first, firstChunks).Outcome);
        Assert.Equal(IngestionOutcome.Conflict, store.Ingest(conflict, conflictingChunks).Outcome);
        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(second, secondChunks).Outcome);
        Assert.Equal("HELLOWORLD", Encoding.UTF8.GetString(
            store.GetSection("t", ObservationSection.Atlas)!.Content));
    }

    [Fact]
    public void Accepted_batch_indexes_are_coherently_bounded()
    {
        const int retention = 4;
        var store = new EdgeObservationStore(idempotencyHistoryLimit: retention);
        var batches = Enumerable.Range(0, 50)
            .Select(index => Batch(
                "c",
                $"batch-{index:D2}",
                Chunk(Json($"{{\"v\":{index}}}"), targetId: $"target-{index:D2}")))
            .ToArray();

        foreach (var batch in batches)
        {
            EdgeBatchValidator.TryValidate(batch, Limits, out var chunks, out _);
            Assert.Equal(IngestionOutcome.Accepted, store.Ingest(batch, chunks).Outcome);
        }

        Assert.Equal(retention, store.AcceptedIdempotencyCount);
        Assert.Equal(retention, store.AcceptedBatchIdCount);

        EdgeBatchValidator.TryValidate(batches[^1], Limits, out var newestChunks, out _);
        Assert.Equal(IngestionOutcome.DuplicateAccepted, store.Ingest(batches[^1], newestChunks).Outcome);
        EdgeBatchValidator.TryValidate(batches[0], Limits, out var evictedChunks, out _);
        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(batches[0], evictedChunks).Outcome);
        Assert.Equal(retention, store.AcceptedIdempotencyCount);
        Assert.Equal(retention, store.AcceptedBatchIdCount);
    }

    private static ObservationBatchV1 CompleteGeneration(string batchId, long sequence = 1, string epoch = "e1")
        => Batch("c", batchId, Enum.GetValues<ObservationSection>()
            .Select(section => Chunk(
                Json($"{{\"s\":\"{section}\",\"n\":{sequence}}}"),
                sequence: sequence,
                epoch: epoch,
                groupId: $"g-{section}",
                section: section))
            .ToArray());

    [Fact]
    public void Unchanged_publication_generation_is_served_without_copying()
    {
        var store = new EdgeObservationStore();
        var first = CompleteGeneration("b1", sequence: 1);
        EdgeBatchValidator.TryValidate(first, Limits, out var firstChunks, out _);
        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(first, firstChunks).Outcome);

        Assert.True(store.TryGetPublishedGenerationIfChanged("t", null, out var projected));
        Assert.NotNull(projected);
        var copiesAfterFirstRead = store.PublishedGenerationCopies;
        Assert.Equal(1, copiesAfterFirstRead);

        // A reader already holding this generation must not pay for another deep copy.
        for (var read = 0; read < 5; read++)
        {
            Assert.False(store.TryGetPublishedGenerationIfChanged(
                "t", projected!.PublicationGeneration, out var repeat));
            Assert.Null(repeat);
        }

        Assert.Equal(copiesAfterFirstRead, store.PublishedGenerationCopies);

        var second = CompleteGeneration("b2", sequence: 2);
        EdgeBatchValidator.TryValidate(second, Limits, out var secondChunks, out _);
        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(second, secondChunks).Outcome);

        Assert.True(store.TryGetPublishedGenerationIfChanged(
            "t", projected!.PublicationGeneration, out var advanced));
        Assert.NotNull(advanced);
        Assert.NotEqual(projected.PublicationGeneration, advanced!.PublicationGeneration);
        Assert.Equal(copiesAfterFirstRead + 1, store.PublishedGenerationCopies);
    }

    [Fact]
    public void Absent_generation_is_a_change_only_for_a_reader_that_had_one()
    {
        var store = new EdgeObservationStore();

        Assert.False(store.TryGetPublishedGenerationIfChanged("absent", null, out var nothing));
        Assert.Null(nothing);

        Assert.True(store.TryGetPublishedGenerationIfChanged("absent", 7, out var cleared));
        Assert.Null(cleared);
        Assert.Equal(0, store.PublishedGenerationCopies);
    }

    [Fact]
    public void Single_section_read_does_not_copy_the_whole_generation()
    {
        var store = new EdgeObservationStore();
        var complete = CompleteGeneration("complete");
        EdgeBatchValidator.TryValidate(complete, Limits, out var chunks, out _);
        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(complete, chunks).Outcome);

        var live = store.GetPublishedSection("t", ObservationSection.Live);
        Assert.NotNull(live);
        Assert.Equal("{\"s\":\"Live\",\"n\":1}", Encoding.UTF8.GetString(live!.Content));
        Assert.Equal(0, store.PublishedGenerationCopies);

        // The caller gets its own bytes: mutating them must not reach back into the store.
        live.Content[0] = (byte)'!';
        Assert.Equal(
            "{\"s\":\"Live\",\"n\":1}",
            Encoding.UTF8.GetString(store.GetPublishedSection("t", ObservationSection.Live)!.Content));
    }

    [Fact]
    public void Section_of_an_incomplete_generation_is_not_published()
    {
        var store = new EdgeObservationStore();
        var partial = Batch("c", "b1", Chunk(Json("{\"v\":1}"), section: ObservationSection.Atlas));
        EdgeBatchValidator.TryValidate(partial, Limits, out var chunks, out _);
        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(partial, chunks).Outcome);

        Assert.NotNull(store.GetSection("t", ObservationSection.Atlas));
        Assert.Null(store.GetPublishedSection("t", ObservationSection.Atlas));
    }

    [Fact]
    public void Aggregate_pending_bytes_per_target_are_bounded()
    {
        var store = new EdgeObservationStore(retention: new EdgeRetentionLimits
        {
            MaxPendingBytesPerTarget = 8,
            MaxPendingBytesTotal = 4096,
        });
        var first = Batch("c", "b1", Chunk(Json("HELLO"), groupId: "g1", index: 0, count: 2));
        var second = Batch("c", "b2", Chunk(
            Json("WORLD"), groupId: "g2", index: 0, count: 2, section: ObservationSection.Live));
        EdgeBatchValidator.TryValidate(first, Limits, out var firstChunks, out _);
        EdgeBatchValidator.TryValidate(second, Limits, out var secondChunks, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(first, firstChunks).Outcome);
        Assert.Equal(IngestionOutcome.Rejected, store.Ingest(second, secondChunks).Outcome);

        // The rejected batch left no trace, and the accepted group still completes.
        var finish = Batch("c", "b3", Chunk(Json("WORLD"), groupId: "g1", index: 1, count: 2));
        EdgeBatchValidator.TryValidate(finish, Limits, out var finishChunks, out _);
        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(finish, finishChunks).Outcome);
        Assert.Equal("HELLOWORLD", Encoding.UTF8.GetString(
            store.GetSection("t", ObservationSection.Atlas)!.Content));
        Assert.Null(store.GetSection("t", ObservationSection.Live));
    }

    [Fact]
    public void Aggregate_pending_bytes_across_targets_are_bounded()
    {
        var store = new EdgeObservationStore(retention: new EdgeRetentionLimits
        {
            MaxPendingBytesPerTarget = 8,
            MaxPendingBytesTotal = 8,
        });
        var first = Batch("c", "b1", Chunk(Json("HELLO"), targetId: "t1", groupId: "g1", index: 0, count: 2));
        var second = Batch("c", "b2", Chunk(Json("WORLD"), targetId: "t2", groupId: "g2", index: 0, count: 2));
        EdgeBatchValidator.TryValidate(first, Limits, out var firstChunks, out _);
        EdgeBatchValidator.TryValidate(second, Limits, out var secondChunks, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(first, firstChunks).Outcome);
        Assert.Equal(IngestionOutcome.Rejected, store.Ingest(second, secondChunks).Outcome);
        Assert.DoesNotContain(store.GetTargets(), target =>
            string.Equals(target.TargetId, "t2", StringComparison.Ordinal));
    }

    [Fact]
    public void In_progress_group_count_per_target_is_bounded()
    {
        var store = new EdgeObservationStore(retention: new EdgeRetentionLimits
        {
            MaxPendingGroupsPerTarget = 1,
        });
        var first = Batch("c", "b1", Chunk(Json("A"), groupId: "g1", index: 0, count: 2));
        var second = Batch("c", "b2", Chunk(
            Json("B"), groupId: "g2", index: 0, count: 2, section: ObservationSection.Live));
        EdgeBatchValidator.TryValidate(first, Limits, out var firstChunks, out _);
        EdgeBatchValidator.TryValidate(second, Limits, out var secondChunks, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(first, firstChunks).Outcome);
        Assert.Equal(IngestionOutcome.Rejected, store.Ingest(second, secondChunks).Outcome);
    }

    [Fact]
    public void Target_count_is_bounded()
    {
        var store = new EdgeObservationStore(retention: new EdgeRetentionLimits { MaxTargets = 1 });
        var first = Batch("c", "b1", Chunk(Json("{\"v\":1}"), targetId: "t1"));
        var second = Batch("c", "b2", Chunk(Json("{\"v\":2}"), targetId: "t2"));
        var pair = Batch(
            "c",
            "b3",
            Chunk(Json("{\"v\":3}"), targetId: "t3"),
            Chunk(Json("{\"v\":4}"), targetId: "t4", groupId: "g2"));
        EdgeBatchValidator.TryValidate(first, Limits, out var firstChunks, out _);
        EdgeBatchValidator.TryValidate(second, Limits, out var secondChunks, out _);
        EdgeBatchValidator.TryValidate(pair, Limits, out var pairChunks, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(first, firstChunks).Outcome);
        Assert.Equal(IngestionOutcome.Rejected, store.Ingest(second, secondChunks).Outcome);
        Assert.Equal("t1", Assert.Single(store.GetTargets()).TargetId);

        var empty = new EdgeObservationStore(retention: new EdgeRetentionLimits { MaxTargets = 1 });
        Assert.Equal(IngestionOutcome.Rejected, empty.Ingest(pair, pairChunks).Outcome);
        Assert.Empty(empty.GetTargets());
    }

    [Fact]
    public void Default_aggregate_bound_never_rejects_a_legal_five_section_backlog()
    {
        // The per-section cap is what bounds one group; the aggregate default must leave room for
        // every section to sit at that cap mid-assembly, or a legitimate connector splitting large
        // sections across batches would start getting rejected for staying within the documented cap.
        var limits = new EdgeRetentionLimits();
        var sections = Enum.GetValues<ObservationSection>().Length;
        var perSectionCap = new IngestionLimits().MaxSectionBytes;

        Assert.True(
            limits.MaxPendingBytesPerTarget >= (long)sections * perSectionCap,
            $"Per-target bound {limits.MaxPendingBytesPerTarget} is below {sections} sections at {perSectionCap}.");
        Assert.True(limits.MaxPendingBytesTotal >= limits.MaxPendingBytesPerTarget);
    }

    [Theory]
    [InlineData(0, 4096, 64, 64)]
    [InlineData(4096, 8, 64, 64)]
    [InlineData(4096, 4096, 0, 64)]
    [InlineData(4096, 4096, 64, 0)]
    public void Incoherent_retention_limits_fail_closed(
        long perTarget, long total, int groups, int targets)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new EdgeObservationStore(
            retention: new EdgeRetentionLimits
            {
                MaxPendingBytesPerTarget = perTarget,
                MaxPendingBytesTotal = total,
                MaxPendingGroupsPerTarget = groups,
                MaxTargets = targets,
            }));
    }

    [Fact]
    public void Multiple_targets_do_not_mix()
    {
        var store = new EdgeObservationStore();
        var t1 = Batch("c", "b1", Chunk(Json("{\"t\":1}"), targetId: "t1"));
        var t2 = Batch("c", "b2", Chunk(Json("{\"t\":2}"), targetId: "t2"));
        EdgeBatchValidator.TryValidate(t1, Limits, out var c1, out _);
        EdgeBatchValidator.TryValidate(t2, Limits, out var c2, out _);
        store.Ingest(t1, c1);
        store.Ingest(t2, c2);

        Assert.Equal("{\"t\":1}", Encoding.UTF8.GetString(store.GetSection("t1", ObservationSection.Atlas)!.Content));
        Assert.Equal("{\"t\":2}", Encoding.UTF8.GetString(store.GetSection("t2", ObservationSection.Atlas)!.Content));
        Assert.Equal(2, store.GetTargets().Count);
    }
}
