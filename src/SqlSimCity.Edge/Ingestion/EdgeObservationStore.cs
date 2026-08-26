using SqlSimCity.Edge.Envelope;

namespace SqlSimCity.Edge.Ingestion;

/// <summary>An immutable, published view of one section's most recently accepted evidence for a target.</summary>
public sealed record SectionGeneration(
    ObservationSection Section,
    long Sequence,
    string EpochId,
    string BootId,
    DateTimeOffset CapturedAt,
    ObservationFreshnessV1 Freshness,
    long Generation,
    byte[] Content);

public sealed record PublishedEdgeGeneration(
    string TargetId,
    string ConnectorId,
    long Sequence,
    string EpochId,
    string BootId,
    DateTimeOffset CapturedAt,
    long PublicationGeneration,
    IReadOnlyDictionary<ObservationSection, SectionGeneration> Sections);

/// <summary>
/// Aggregate residency bounds for the whole store. The per-section cap only bounds one section
/// group, so without these an aggressive or hostile connector can grow resident memory without
/// limit by opening many partial groups, many sections, or many targets at once. Every bound fails
/// closed with a fixed, non-secret reason; evidence is never silently dropped.
/// <para>
/// The defaults are deliberately set so nothing a connector can legally do under the existing
/// per-section cap is newly rejected: five sections at the 32 MiB cap is 160 MiB, so that is the
/// per-target ceiling. These bound the pathological case, not the legitimate one.
/// </para>
/// </summary>
public sealed record EdgeRetentionLimits
{
    /// <summary>Sections in a complete generation; the per-target default is this many at the section cap.</summary>
    private const int SectionCount = 5;

    /// <summary>Maximum buffered bytes across every in-progress section group of one target.</summary>
    public long MaxPendingBytesPerTarget { get; init; } = SectionCount * 32L * 1024 * 1024;

    /// <summary>Maximum buffered bytes across every in-progress section group of every target.</summary>
    public long MaxPendingBytesTotal { get; init; } = 2 * SectionCount * 32L * 1024 * 1024;

    /// <summary>Maximum in-progress section groups one target may hold open at once.</summary>
    public int MaxPendingGroupsPerTarget { get; init; } = 64;

    /// <summary>Maximum number of distinct targets the store will ever hold state for.</summary>
    public int MaxTargets { get; init; } = 64;

    public void Validate()
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(MaxPendingBytesPerTarget, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(MaxPendingBytesTotal, MaxPendingBytesPerTarget);
        ArgumentOutOfRangeException.ThrowIfLessThan(MaxPendingGroupsPerTarget, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(MaxTargets, 1);
    }
}

/// <summary>A generic, non-secret status summary for one monitored target, for the source/status panel.</summary>
public sealed record EdgeTargetStatus(
    string TargetId,
    string ConnectorId,
    long LastSequence,
    string EpochId,
    DateTimeOffset LastCapturedAt,
    IReadOnlyList<ObservationSection> Sections,
    bool Fresh);

/// <summary>
/// Holds the immutable observation generations assembled from accepted connector batches, keyed by
/// target and section. Chunks of a section may arrive across several batches (paged Query Store, or a
/// 413 split); the store buffers a group's chunks and publishes the section only when the group is
/// complete, so a partial generation is never visible. Ingestion is atomic per batch: idempotency,
/// epoch, and sequence conflicts are resolved before any chunk is buffered, so a rejected batch
/// leaves no trace. Edge targets live in their own namespace and can never replace a fixture or
/// connected source; multiple connectors and targets coexist without mixing ids. Residency is
/// bounded per section, per target, and across the whole store, so an aggressive or hostile
/// connector cannot grow resident memory without limit.
/// </summary>
public sealed class EdgeObservationStore
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, TargetState> _targets = new(StringComparer.Ordinal);
    private readonly HashSet<string> _acceptedIdempotencyKeys = new(StringComparer.Ordinal);
    private readonly Queue<(string BatchId, string Key)> _idempotencyOrder = new();
    private readonly Dictionary<string, string> _batchIdToKey = new(StringComparer.Ordinal);
    private readonly int _idempotencyHistoryLimit;
    private readonly int _maxSectionBytes;
    private readonly EdgeRetentionLimits _retention;
    private readonly TimeProvider _timeProvider;
    private readonly Func<PublishedEdgeGeneration, string?>? _generationValidator;
    private long _generation;
    private long _publishedGenerationCopies;

    public EdgeObservationStore(
        TimeProvider? timeProvider = null,
        int idempotencyHistoryLimit = 8192,
        int maxSectionBytes = 32 * 1024 * 1024,
        Func<PublishedEdgeGeneration, string?>? generationValidator = null,
        EdgeRetentionLimits? retention = null)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(idempotencyHistoryLimit, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxSectionBytes, 1);
        _timeProvider = timeProvider ?? TimeProvider.System;
        _idempotencyHistoryLimit = idempotencyHistoryLimit;
        _maxSectionBytes = maxSectionBytes;
        _retention = retention ?? new EdgeRetentionLimits();
        _retention.Validate();
        _generationValidator = generationValidator;
    }

    internal int AcceptedIdempotencyCount
    {
        get { lock (_gate) return _acceptedIdempotencyKeys.Count; }
    }

    internal int AcceptedBatchIdCount
    {
        get { lock (_gate) return _batchIdToKey.Count; }
    }

    /// <summary>
    /// Read-path deep copies of a full published generation. Each one duplicates every section's
    /// bytes under the global lock, so a reader whose projection is already current must not add one.
    /// </summary>
    internal long PublishedGenerationCopies
    {
        get { lock (_gate) return _publishedGenerationCopies; }
    }

    /// <summary>
    /// Commits an already structurally validated batch. Applies idempotency, epoch, and sequence
    /// rules atomically, then buffers chunks and publishes any section whose group completed.
    /// </summary>
    public IngestionResult Ingest(ObservationBatchV1 batch, IReadOnlyList<ValidatedChunk> chunks)
    {
        ArgumentNullException.ThrowIfNull(batch);
        ArgumentNullException.ThrowIfNull(chunks);

        lock (_gate)
        {
            if (_acceptedIdempotencyKeys.Contains(batch.IdempotencyKey))
                return IngestionResult.Duplicate;

            if (_batchIdToKey.TryGetValue(batch.BatchId, out var priorKey) &&
                !string.Equals(priorKey, batch.IdempotencyKey, StringComparison.Ordinal))
            {
                return IngestionResult.Conflict("Batch id was reused with different content.");
            }

            var stagedTargets = new Dictionary<string, TargetState>(StringComparer.Ordinal);
            var stagedGeneration = _generation;
            foreach (var chunk in chunks)
            {
                if (!stagedTargets.TryGetValue(chunk.TargetId, out var state))
                {
                    if (!_targets.TryGetValue(chunk.TargetId, out var existing))
                    {
                        if (StagedTargetCount(stagedTargets) + 1 > _retention.MaxTargets)
                            return IngestionResult.Rejected("Server holds the maximum number of monitored targets.");
                        state = new TargetState(chunk.TargetId, batch.ConnectorId);
                    }
                    else
                    {
                        state = existing.Clone();
                    }

                    stagedTargets.Add(chunk.TargetId, state);
                }

                if (!string.Equals(state.ConnectorId, batch.ConnectorId, StringComparison.Ordinal))
                    return IngestionResult.Conflict("Target is already owned by a different connector.");

                var admission = state.Evaluate(chunk);
                if (admission != AdmissionDecision.Admit)
                {
                    return admission == AdmissionDecision.RetiredEpoch
                        ? IngestionResult.Conflict("Chunk references a retired epoch.")
                        : admission == AdmissionDecision.Rollback
                            ? IngestionResult.Conflict("Chunk sequence rolls back published state.")
                            : IngestionResult.Conflict("Chunk conflicts with an in-progress group.");
                }

                if (state.ProjectedBytes(chunk) > _maxSectionBytes)
                    return IngestionResult.Rejected("Section exceeds the maximum reassembled size.");

                state.Admit(chunk, () => ++stagedGeneration);
                state.TryPublishComplete();

                // Aggregate residency is checked after every chunk rather than once at the end, so a
                // hostile batch cannot walk past a bound part-way through. The staged clone is
                // discarded on rejection, so nothing over the bound is ever retained; the transient
                // peak stays bounded by the per-batch and per-chunk limits.
                if (state.PendingGroupCount > _retention.MaxPendingGroupsPerTarget)
                    return IngestionResult.Rejected("Target holds the maximum number of in-progress section groups.");
                if (state.TotalPendingBytes > _retention.MaxPendingBytesPerTarget)
                    return IngestionResult.Rejected("Target exceeds the maximum buffered evidence size.");
                if (StagedPendingBytes(stagedTargets) > _retention.MaxPendingBytesTotal)
                    return IngestionResult.Rejected("Server exceeds the maximum buffered evidence size.");
            }

            if (_generationValidator is not null)
            {
                foreach (var generation in stagedTargets.Values
                             .Select(state => state.PublishedGeneration)
                             .Where(value => value is not null && value.PublicationGeneration > _generation))
                {
                    if (_generationValidator(generation!) is { } reason)
                        return IngestionResult.Rejected(reason);
                }
            }

            foreach (var (targetId, state) in stagedTargets)
                _targets[targetId] = state;
            _generation = stagedGeneration;
            RecordIdempotency(batch.BatchId, batch.IdempotencyKey);
            return IngestionResult.Accepted;
        }
    }

    /// <summary>Returns the latest published generation for one section of a target, or <c>null</c>.</summary>
    public SectionGeneration? GetSection(string targetId, ObservationSection section)
    {
        lock (_gate)
        {
            return _targets.TryGetValue(targetId, out var state) ? state.GetSection(section) : null;
        }
    }

    /// <summary>
    /// Returns a full deep copy of the target's published generation. This duplicates every
    /// section's bytes under the global lock, which also blocks ingestion for the duration — up to
    /// ~160 MiB with sections at their cap. Prefer
    /// <see cref="TryGetPublishedGenerationIfChanged"/> for a projection that may already be current,
    /// or <see cref="GetPublishedSection"/> to serve a single section.
    /// </summary>
    public PublishedEdgeGeneration? GetPublishedGeneration(string targetId)
    {
        lock (_gate)
        {
            if (!_targets.TryGetValue(targetId, out var state) || state.PublishedGeneration is null)
                return null;
            _publishedGenerationCopies++;
            return state.GetPublishedGeneration();
        }
    }

    /// <summary>
    /// Atomically compares the caller's already-projected publication generation against the
    /// published one and clones only when they differ. A caller whose projection is still current
    /// pays no copy at all — which matters because cloning a generation deep-copies every section's
    /// bytes under this store's global lock, blocking ingestion for the duration.
    /// <paramref name="generation"/> is the fresh clone when the result is <c>true</c>, or
    /// <c>null</c> when nothing is published for the target (itself a change if the caller had a
    /// projection). Cloning stays inside the lock: handing out the internal arrays instead would
    /// trade the copy for a data race.
    /// </summary>
    public bool TryGetPublishedGenerationIfChanged(
        string targetId,
        long? knownPublicationGeneration,
        out PublishedEdgeGeneration? generation)
    {
        lock (_gate)
        {
            var published = _targets.TryGetValue(targetId, out var state) ? state.PublishedGeneration : null;
            if (published?.PublicationGeneration == knownPublicationGeneration)
            {
                generation = null;
                return false;
            }

            generation = published is null ? null : TargetState.Clone(published);
            if (generation is not null)
                _publishedGenerationCopies++;
            return true;
        }
    }

    /// <summary>
    /// Returns one section of the target's published generation, cloning only that section. A
    /// caller serving a single section never pays for a clone of the other four.
    /// </summary>
    public SectionGeneration? GetPublishedSection(string targetId, ObservationSection section)
    {
        lock (_gate)
        {
            return _targets.TryGetValue(targetId, out var state)
                ? state.GetPublishedSection(section)
                : null;
        }
    }

    /// <summary>Returns a status summary for every known target.</summary>
    public IReadOnlyList<EdgeTargetStatus> GetTargets()
    {
        lock (_gate)
        {
            var now = _timeProvider.GetUtcNow();
            return _targets.Values.Select(state => state.ToStatus(now)).ToArray();
        }
    }

    private int StagedTargetCount(IReadOnlyDictionary<string, TargetState> staged) =>
        _targets.Count + staged.Keys.Count(targetId => !_targets.ContainsKey(targetId));

    private long StagedPendingBytes(IReadOnlyDictionary<string, TargetState> staged)
    {
        var total = staged.Values.Sum(state => state.TotalPendingBytes);
        foreach (var (targetId, state) in _targets)
        {
            if (!staged.ContainsKey(targetId))
                total += state.TotalPendingBytes;
        }

        return total;
    }

    private void RecordIdempotency(string batchId, string key)
    {
        if (_acceptedIdempotencyKeys.Add(key))
        {
            _idempotencyOrder.Enqueue((batchId, key));
            _batchIdToKey[batchId] = key;
            while (_idempotencyOrder.Count > _idempotencyHistoryLimit)
            {
                var evicted = _idempotencyOrder.Dequeue();
                _acceptedIdempotencyKeys.Remove(evicted.Key);
                if (_batchIdToKey.TryGetValue(evicted.BatchId, out var mapped) &&
                    string.Equals(mapped, evicted.Key, StringComparison.Ordinal))
                {
                    _batchIdToKey.Remove(evicted.BatchId);
                }
            }
        }
    }

    private enum AdmissionDecision { Admit, RetiredEpoch, Rollback, GroupConflict }

    private sealed class TargetState
    {
        private readonly string _targetId;
        private readonly Dictionary<ObservationSection, SectionSlot> _slots;
        private readonly HashSet<string> _retiredEpochs;

        public string ConnectorId { get; }
        public string EpochId { get; private set; } = string.Empty;
        public long LastSequence { get; private set; } = -1;
        public DateTimeOffset LastCapturedAt { get; private set; }
        public PublishedEdgeGeneration? PublishedGeneration { get; private set; }

        public TargetState(string targetId, string connectorId)
            : this(targetId, connectorId, new Dictionary<ObservationSection, SectionSlot>(),
                new HashSet<string>(StringComparer.Ordinal))
        {
        }

        private TargetState(
            string targetId,
            string connectorId,
            Dictionary<ObservationSection, SectionSlot> slots,
            HashSet<string> retiredEpochs)
        {
            _targetId = targetId;
            ConnectorId = connectorId;
            _slots = slots;
            _retiredEpochs = retiredEpochs;
        }

        public TargetState Clone()
        {
            var clone = new TargetState(
                _targetId,
                ConnectorId,
                _slots.ToDictionary(pair => pair.Key, pair => pair.Value.Clone()),
                new HashSet<string>(_retiredEpochs, StringComparer.Ordinal))
            {
                EpochId = EpochId,
                LastSequence = LastSequence,
                LastCapturedAt = LastCapturedAt,
                PublishedGeneration = CloneGeneration(PublishedGeneration),
            };
            return clone;
        }

        public AdmissionDecision Evaluate(ValidatedChunk chunk)
        {
            if (!string.Equals(chunk.EpochId, EpochId, StringComparison.Ordinal))
                return _retiredEpochs.Contains(chunk.EpochId) ? AdmissionDecision.RetiredEpoch : AdmissionDecision.Admit;

            // Same epoch: never accept a sequence that regresses a section already published at a
            // higher sequence. Equal or higher is allowed (equal supports multi-batch group assembly).
            if (!_slots.TryGetValue(chunk.Section, out var slot))
                return AdmissionDecision.Admit;
            if (chunk.Sequence < slot.PublishedSequence)
                return AdmissionDecision.Rollback;
            return slot.CanBuffer(chunk) ? AdmissionDecision.Admit : AdmissionDecision.GroupConflict;
        }

        public long ProjectedBytes(ValidatedChunk chunk)
        {
            if (!string.Equals(chunk.EpochId, EpochId, StringComparison.Ordinal))
                return chunk.Content.LongLength;
            return _slots.TryGetValue(chunk.Section, out var slot)
                ? slot.ProjectedBytes(chunk)
                : chunk.Content.LongLength;
        }

        public void Admit(ValidatedChunk chunk, Func<long> nextGeneration)
        {
            if (!string.Equals(chunk.EpochId, EpochId, StringComparison.Ordinal))
            {
                if (!string.IsNullOrEmpty(EpochId))
                    _retiredEpochs.Add(EpochId);
                EpochId = chunk.EpochId;
                LastSequence = -1;
                foreach (var slot in _slots.Values)
                    slot.ResetForNewEpoch();
            }

            LastSequence = Math.Max(LastSequence, chunk.Sequence);
            if (chunk.CapturedAt > LastCapturedAt)
                LastCapturedAt = chunk.CapturedAt;

            var target = GetSlot(chunk.Section);
            target.Buffer(chunk, nextGeneration);
        }

        public SectionGeneration? GetSection(ObservationSection section)
            => _slots.TryGetValue(section, out var slot) ? slot.Published : null;

        public PublishedEdgeGeneration? GetPublishedGeneration() => CloneGeneration(PublishedGeneration);

        public SectionGeneration? GetPublishedSection(ObservationSection section) =>
            PublishedGeneration is not null && PublishedGeneration.Sections.TryGetValue(section, out var published)
                ? CloneSection(published)
                : null;

        /// <summary>Buffered bytes across every in-progress group of every section of this target.</summary>
        public long TotalPendingBytes => _slots.Values.Sum(slot => slot.TotalPendingBytes);

        /// <summary>In-progress groups across every section of this target.</summary>
        public int PendingGroupCount => _slots.Values.Sum(slot => slot.PendingGroupCount);

        public void TryPublishComplete()
        {
            var sections = Enum.GetValues<ObservationSection>()
                .Select(section => _slots.TryGetValue(section, out var slot) ? slot.Published : null)
                .ToArray();
            if (sections.Any(section => section is null))
                return;

            var complete = sections.Select(section => section!).ToArray();
            var first = complete[0];
            if (complete.Any(section =>
                    section.Sequence != first.Sequence ||
                    !string.Equals(section.EpochId, first.EpochId, StringComparison.Ordinal) ||
                    !string.Equals(section.BootId, first.BootId, StringComparison.Ordinal)))
            {
                return;
            }

            if (PublishedGeneration is not null &&
                PublishedGeneration.Sequence == first.Sequence &&
                string.Equals(PublishedGeneration.EpochId, first.EpochId, StringComparison.Ordinal))
            {
                return;
            }

            PublishedGeneration = new PublishedEdgeGeneration(
                _targetId,
                ConnectorId,
                first.Sequence,
                first.EpochId,
                first.BootId,
                complete.Max(section => section.CapturedAt),
                complete.Max(section => section.Generation),
                complete.ToDictionary(section => section.Section, CloneSection));
        }

        public long PendingBytes(ObservationSection section, string epochId, long sequence, string groupId)
        {
            // A group buffered under a since-retired/replaced epoch contributes nothing.
            if (!string.Equals(epochId, EpochId, StringComparison.Ordinal))
                return 0;
            return _slots.TryGetValue(section, out var slot) ? slot.PendingBytes(epochId, sequence, groupId) : 0;
        }

        public EdgeTargetStatus ToStatus(DateTimeOffset now)
        {
            var published = PublishedGeneration?.Sections.Values.ToArray() ?? [];
            var fresh = published.Length > 0 && published.All(section =>
                section.Freshness.FreshUntil is null || section.Freshness.FreshUntil >= now);
            return new EdgeTargetStatus(
                _targetId,
                ConnectorId,
                PublishedGeneration?.Sequence ?? -1,
                PublishedGeneration?.EpochId ?? EpochId,
                PublishedGeneration?.CapturedAt ?? LastCapturedAt,
                published.Select(section => section.Section).OrderBy(value => value).ToArray(),
                fresh);
        }

        private SectionSlot GetSlot(ObservationSection section)
        {
            if (!_slots.TryGetValue(section, out var slot))
            {
                slot = new SectionSlot(section);
                _slots[section] = slot;
            }

            return slot;
        }

        private static PublishedEdgeGeneration? CloneGeneration(PublishedEdgeGeneration? generation) =>
            generation is null ? null : Clone(generation);

        public static PublishedEdgeGeneration Clone(PublishedEdgeGeneration generation) =>
            generation with
            {
                Sections = generation.Sections.ToDictionary(
                    pair => pair.Key,
                    pair => CloneSection(pair.Value)),
            };

        private static SectionGeneration CloneSection(SectionGeneration section) =>
            section with { Content = (byte[])section.Content.Clone() };
    }

    private sealed class SectionSlot(ObservationSection section)
    {
        private readonly Dictionary<string, PartialGroup> _pending = new(StringComparer.Ordinal);

        public long PublishedSequence { get; private set; } = -1;
        public SectionGeneration? Published { get; private set; }

        /// <summary>Buffered bytes across this section's in-progress groups.</summary>
        public long TotalPendingBytes => _pending.Values.Sum(group => group.BufferedBytes);

        /// <summary>In-progress groups this section is holding open.</summary>
        public int PendingGroupCount => _pending.Count;

        public SectionSlot Clone()
        {
            var clone = new SectionSlot(section)
            {
                PublishedSequence = PublishedSequence,
                Published = Published is null ? null : Published with { Content = (byte[])Published.Content.Clone() },
            };
            foreach (var (key, value) in _pending)
                clone._pending.Add(key, value.Clone());
            return clone;
        }

        public void ResetForNewEpoch()
        {
            _pending.Clear();
            PublishedSequence = -1;
            Published = null;
        }

        public bool CanBuffer(ValidatedChunk chunk)
        {
            var groupKey = GroupKey(chunk);
            return !_pending.TryGetValue(groupKey, out var group) || group.CanAccept(chunk);
        }

        public long ProjectedBytes(ValidatedChunk chunk)
        {
            var groupKey = GroupKey(chunk);
            return _pending.TryGetValue(groupKey, out var group)
                ? group.ProjectedBytes(chunk)
                : chunk.Content.LongLength;
        }

        public long PendingBytes(string epochId, long sequence, string groupId)
        {
            var groupKey = $"{epochId}\u0001{sequence}\u0001{groupId}";
            return _pending.TryGetValue(groupKey, out var group) ? group.BufferedBytes : 0;
        }

        public void Buffer(ValidatedChunk chunk, Func<long> nextGeneration)
        {
            var groupKey = GroupKey(chunk);
            if (!_pending.TryGetValue(groupKey, out var group))
            {
                group = new PartialGroup(chunk.ChunkCount);
                _pending[groupKey] = group;
            }

            group.Add(chunk);
            if (!group.IsComplete)
                return;

            _pending.Remove(groupKey);
            if (chunk.Sequence <= PublishedSequence)
                return; // A newer generation already won; drop the late group.

            Published = new SectionGeneration(
                section, chunk.Sequence, chunk.EpochId, chunk.BootId, chunk.CapturedAt,
                chunk.Freshness, nextGeneration(), group.Reassemble());
            PublishedSequence = chunk.Sequence;

            // Any still-pending group at or below the just-published sequence is now stale.
            foreach (var stale in _pending
                         .Where(pair => ParseSequence(pair.Key) <= PublishedSequence)
                         .Select(pair => pair.Key).ToArray())
            {
                _pending.Remove(stale);
            }
        }

        private static string GroupKey(ValidatedChunk chunk) =>
            $"{chunk.EpochId}\u0001{chunk.Sequence}\u0001{chunk.ChunkGroupId}";

        private static long ParseSequence(string groupKey)
        {
            var parts = groupKey.Split('\u0001');
            return long.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture);
        }
    }

    private sealed class PartialGroup(int chunkCount)
    {
        private readonly Dictionary<int, byte[]> _chunks = new();

        public bool IsComplete => _chunks.Count == chunkCount;

        public long BufferedBytes { get; private set; }

        public PartialGroup Clone()
        {
            var clone = new PartialGroup(chunkCount);
            foreach (var (index, content) in _chunks)
                clone._chunks.Add(index, (byte[])content.Clone());
            clone.BufferedBytes = BufferedBytes;
            return clone;
        }

        public bool CanAccept(ValidatedChunk chunk)
        {
            if (chunk.ChunkCount != chunkCount)
                return false;
            return !_chunks.TryGetValue(chunk.ChunkIndex, out var existing) ||
                   existing.AsSpan().SequenceEqual(chunk.Content);
        }

        public long ProjectedBytes(ValidatedChunk chunk) =>
            BufferedBytes + (_chunks.ContainsKey(chunk.ChunkIndex) ? 0 : chunk.Content.LongLength);

        public void Add(ValidatedChunk chunk)
        {
            if (_chunks.TryAdd(chunk.ChunkIndex, (byte[])chunk.Content.Clone()))
                BufferedBytes += chunk.Content.LongLength;
        }

        public byte[] Reassemble()
        {
            long total = 0;
            for (var i = 0; i < chunkCount; i++)
                total += _chunks[i].Length;

            var buffer = new byte[total];
            var offset = 0;
            for (var i = 0; i < chunkCount; i++)
            {
                var chunk = _chunks[i];
                Array.Copy(chunk, 0, buffer, offset, chunk.Length);
                offset += chunk.Length;
            }

            return buffer;
        }
    }
}
