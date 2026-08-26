using System.Diagnostics.CodeAnalysis;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Threading.Channels;
using SqlSimCity.Storage.Crypto;

namespace SqlSimCity.Storage.Sqlite;

/// <summary>
/// Turns the caller's lazy replacement sequence into envelopes on a producer task, and hands
/// them to the writer one bounded batch at a time.
/// <para>
/// The point is which thread pays for the preparation. <c>ReplaceSetAsync</c> used to enumerate
/// the sequence from inside its own transaction, so every <c>MoveNext</c> -- a JSON
/// serialization of a Query Store family, then <see cref="EnvelopeCodec.Wrap"/> over the result
/// -- ran with the SQLite write lock held and other writers already queued behind it. That work
/// depends on nothing the transaction knows, so it does not have to be inside it. Measured at
/// 6,000 families it was about 40% of the hold.
/// </para>
/// <para>
/// Memory is the trade, and it is bounded by the batch budget rather than by the snapshot: at
/// most three batches are alive at once -- the one being filled, the one queued, and the one
/// being written -- so peak buffering is roughly
/// <c>3 x (<see cref="BatchBudgetBytes"/> + one record)</c>, about 9 MiB with the default 1 MiB
/// record limit, whether the publish carries six thousand families or a hundred thousand.
/// Materializing the whole snapshot instead would be ~580 MB at 100k families, which is why
/// this streams rather than hoisting.
/// </para>
/// <para>
/// Preparing eagerly is also what makes the hand-off safe. A payload handed to
/// <c>ReplaceSetAsync</c> is only valid until the enumerator advances -- the repository's
/// iterators zero their serialization buffers in a <c>finally</c> after each <c>yield</c> -- so
/// a buffer of <see cref="ProtectedRecordWrite"/> would read back zeros. The envelope is an
/// independent copy taken before the enumerator moves on, so buffering it is sound.
/// </para>
/// </summary>
internal sealed class PreparedRecordPipeline : IAsyncDisposable
{
    /// <summary>Bytes of envelope a batch accumulates before it is handed over.</summary>
    private const int BatchBudgetBytes = 2 * 1024 * 1024;

    /// <summary>
    /// Also cap the count, so a set of very small records -- index pages, plan-cache
    /// evictions -- hands over on a bounded number of items instead of accumulating a
    /// list long enough to matter.
    /// </summary>
    private const int BatchRecordCap = 512;

    private readonly Channel<List<PreparedRecord>> _channel =
        Channel.CreateBounded<List<PreparedRecord>>(new BoundedChannelOptions(1)
        {
            SingleReader = true,
            SingleWriter = true,
            FullMode = BoundedChannelFullMode.Wait,
            // The writer must keep running on its own thread while the producer prepares the
            // next batch. Letting a hand-off run the other side's continuation inline would
            // put them back on one thread and give the overlap up.
            AllowSynchronousContinuations = false,
        });

    private readonly IEnumerable<ProtectedRecordWrite> _records;
    private readonly string _idPrefix;
    private readonly SqliteProtectedRecordStore _store;
    private readonly CancellationTokenSource _abort;
    private readonly Task _producer;
    private Exception? _failure;

    public PreparedRecordPipeline(
        IEnumerable<ProtectedRecordWrite> records,
        string idPrefix,
        SqliteProtectedRecordStore store,
        CancellationToken cancellationToken)
    {
        _records = records;
        _idPrefix = idPrefix;
        _store = store;
        _abort = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        // Started before the caller opens its connection, so connection setup and the prefix
        // delete are head start rather than dead time.
        _producer = Task.Run(ProduceAsync, CancellationToken.None);
    }

    /// <summary>Batches in the order the sequence produced them, ending when it is exhausted.</summary>
    public IAsyncEnumerable<List<PreparedRecord>> Batches =>
        _channel.Reader.ReadAllAsync(CancellationToken.None);

    /// <summary>
    /// Rethrows whatever stopped the producer, preserving its type and its original stack, so a
    /// caller still sees the <see cref="ArgumentException"/> a rejected record raised rather than
    /// a wrapper. Call it before committing: the batches simply stop arriving on failure, and a
    /// reader that only watched for the end of the sequence would commit a partial set.
    /// </summary>
    public void ThrowIfFailed()
    {
        if (_failure is not null) ExceptionDispatchInfo.Throw(_failure);
    }

    private async Task ProduceAsync()
    {
        var token = _abort.Token;
        var batch = new List<PreparedRecord>();
        var batchBytes = 0;
        try
        {
            foreach (var record in _records)
            {
                token.ThrowIfCancellationRequested();
                Validate(record);
                var envelope = EnvelopeCodec.Wrap(
                    record.RecordKind, record.Id.Value, record.Payload.Span);
                batch.Add(new PreparedRecord(
                    record.Id.Value,
                    record.RecordKind,
                    record.CapturedAt.ToUnixTimeMilliseconds(),
                    record.Resolution.ToString(),
                    record.Payload.Length,
                    envelope));
                batchBytes += envelope.Length;
                if (batch.Count < BatchRecordCap && batchBytes < BatchBudgetBytes) continue;

                await _channel.Writer.WriteAsync(batch, token).ConfigureAwait(false);
                batch = [];
                batchBytes = 0;
            }

            if (batch.Count > 0)
            {
                await _channel.Writer.WriteAsync(batch, token).ConfigureAwait(false);
                batch = [];
            }
        }
        catch (Exception exception)
        {
            _failure = exception;
        }
        finally
        {
            // Whatever never reached the writer is still ours to clear.
            Zero(batch);
            _channel.Writer.Complete();
        }
    }

    private void Validate(ProtectedRecordWrite record)
    {
        // The store owns the limits and their wording, so a record rejected here reports exactly
        // what the same record rejected by PutAsync would.
        _store.ValidateWrite(record.RecordKind, record.Payload);
        if (!record.Id.Value.StartsWith(_idPrefix, StringComparison.Ordinal))
            ThrowPrefixMismatch(_records);
    }

    /// <summary>
    /// Named so the rejection still points at <c>ReplaceSetAsync</c>'s <c>records</c> parameter,
    /// which is the argument the caller can actually fix, rather than at anything in here.
    /// </summary>
    [DoesNotReturn]
    private static void ThrowPrefixMismatch(IEnumerable<ProtectedRecordWrite> records) =>
        throw new ArgumentException(
            "Every replacement record id must start with the set prefix.", nameof(records));

    internal static void Zero(List<PreparedRecord> batch)
    {
        foreach (var prepared in batch)
            CryptographicOperations.ZeroMemory(prepared.Envelope);
        batch.Clear();
    }

    public async ValueTask DisposeAsync()
    {
        // Unblocks a producer parked on the bounded hand-off when the writer gave up early, so
        // no preparation outlives the call that asked for it.
        await _abort.CancelAsync().ConfigureAwait(false);
        await _producer.ConfigureAwait(false);
        while (_channel.Reader.TryRead(out var batch)) Zero(batch);
        _abort.Dispose();
    }
}

/// <summary>
/// One record with its envelope already built, so binding it costs no more than reading fields.
/// </summary>
internal readonly record struct PreparedRecord(
    string Id,
    string RecordKind,
    long CapturedAtUnixMs,
    string Resolution,
    int PayloadLength,
    byte[] Envelope);
