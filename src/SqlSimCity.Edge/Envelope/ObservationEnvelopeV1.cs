namespace SqlSimCity.Edge.Envelope;

/// <summary>
/// The source-neutral evidence section a chunk carries. These map one-to-one onto the
/// existing SQLSimCity V1 contract seams; the edge connector never invents a new evidence
/// class. Delivered evidence is projected without running an assessment engine.
/// </summary>
public enum ObservationSection
{
    /// <summary>An <c>AtlasSnapshotV1</c> plus its collector status.</summary>
    Atlas,

    /// <summary>Negotiated <c>TargetCapabilityProfileV1</c> values.</summary>
    Capabilities,

    /// <summary>A point-in-time <c>LiveIncidentResponseV1</c> sample.</summary>
    Live,

    /// <summary>Bounded, paged Query Store history (status/pointer/chunk).</summary>
    QueryStore,

    /// <summary>Database-city availability and object inventory.</summary>
    DatabaseCity,
}

/// <summary>How a chunk's payload bytes were encoded before the content digest was taken.</summary>
public enum ObservationCompression
{
    /// <summary>Raw UTF-8 JSON bytes.</summary>
    None,

    /// <summary>RFC 1952 gzip of the UTF-8 JSON bytes.</summary>
    Gzip,
}

/// <summary>
/// Source freshness metadata carried alongside every observation so a central reader never
/// mistakes an aggregate window or a point-in-time sample for a continuous trace. Values mirror
/// the freshness triplet the underlying evidence path already exposes.
/// </summary>
/// <param name="SourceTimestamp">When the target produced the data, if known.</param>
/// <param name="CollectedAt">When the connector observed it.</param>
/// <param name="FreshUntil">The cadence-derived staleness boundary, if the section defines one.</param>
public sealed record ObservationFreshnessV1(
    DateTimeOffset? SourceTimestamp,
    DateTimeOffset CollectedAt,
    DateTimeOffset? FreshUntil);

/// <summary>
/// One versioned, self-describing observation chunk. Large sections (notably Query Store history)
/// are split at predefined boundaries into ordered chunks that share a <see cref="ChunkGroupId"/>;
/// small sections are a single chunk. The payload is always the exact bytes the
/// <see cref="ContentDigest"/> was computed over, so a central reader can verify integrity before
/// decoding. Raw SQL and Showplan XML are never transmitted: text and plans are normalized and
/// redacted by the producing seam before they reach this envelope.
/// </summary>
/// <param name="SchemaVersion">Envelope schema version, currently <c>"1.0"</c>.</param>
/// <param name="ConnectorId">Opaque, stable connector identity (never a hostname or secret).</param>
/// <param name="TargetId">Opaque, stable monitored-target identity.</param>
/// <param name="Sequence">Per-target monotonically increasing publication sequence.</param>
/// <param name="EpochId">
/// Opaque per-boot epoch. A connector restart or an observed counter/reset regression starts a new
/// epoch so a central reader never computes a false delta across a discontinuity.
/// </param>
/// <param name="BootId">Opaque identifier of the connector process instance that produced the chunk.</param>
/// <param name="CapturedAt">When the connector captured this observation.</param>
/// <param name="Section">Which evidence seam this chunk carries.</param>
/// <param name="ChunkGroupId">Groups the ordered chunks of one logical section together.</param>
/// <param name="ChunkIndex">Zero-based index of this chunk within its group.</param>
/// <param name="ChunkCount">Total number of chunks in the group.</param>
/// <param name="Compression">How <see cref="Payload"/> was encoded.</param>
/// <param name="ContentDigest">Lowercase hex SHA-256 of the exact <see cref="Payload"/> bytes.</param>
/// <param name="Freshness">Source freshness metadata for the carried evidence.</param>
/// <param name="Payload">Base64 of the (optionally compressed) evidence bytes.</param>
public sealed record ObservationEnvelopeV1(
    string SchemaVersion,
    string ConnectorId,
    string TargetId,
    long Sequence,
    string EpochId,
    string BootId,
    DateTimeOffset CapturedAt,
    ObservationSection Section,
    string ChunkGroupId,
    int ChunkIndex,
    int ChunkCount,
    ObservationCompression Compression,
    string ContentDigest,
    ObservationFreshnessV1 Freshness,
    string Payload);

/// <summary>
/// The unit of outward delivery, spooling, and central idempotency. A batch is an ordered set of
/// chunks produced in one collection cycle. Its <see cref="BatchId"/> and <see cref="IdempotencyKey"/>
/// let the central server accept a retransmission exactly once and reject a conflicting reuse.
/// </summary>
/// <param name="SchemaVersion">Batch schema version, currently <c>"1.0"</c>.</param>
/// <param name="ConnectorId">Opaque connector identity; must match every contained chunk.</param>
/// <param name="BatchId">Opaque, unique-per-batch identifier.</param>
/// <param name="IdempotencyKey">
/// Stable key derived from the connector id, target ids, sequence span, and content digests, so an
/// identical batch retransmitted after a network failure resolves to the same key.
/// </param>
/// <param name="CreatedAt">When the connector sealed this batch for delivery.</param>
/// <param name="PublishedAt">When the connector last attempted to publish this batch.</param>
/// <param name="Envelopes">The ordered chunks in this batch.</param>
public sealed record ObservationBatchV1(
    string SchemaVersion,
    string ConnectorId,
    string BatchId,
    string IdempotencyKey,
    DateTimeOffset CreatedAt,
    DateTimeOffset PublishedAt,
    IReadOnlyList<ObservationEnvelopeV1> Envelopes);
