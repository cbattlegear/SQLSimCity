using SqlSimCity.Edge.Delivery;
using SqlSimCity.Edge.Spool;

namespace SqlSimCity.Edge.Connector;

/// <summary>
/// Coordinates the connector's two bounded, non-overlapping loops: a collection loop that builds one
/// batch per cadence and durably spools it (applying backpressure), and a delivery loop that drains
/// the spool oldest-first, honoring 429/Retry-After, splitting 413 at chunk boundaries, and stopping
/// on auth failure instead of retry-storming. Neither loop keeps unbounded in-memory state — the
/// backlog lives in the bounded spool. When the spool rejects a batch the collection cadence backs
/// off exponentially, so a long outage stops re-paying for evidence that cannot be stored. On
/// shutdown the delivery loop performs one final, time-bounded drain so queued evidence has a chance
/// to flush before the process exits.
/// </summary>
public sealed class ConnectorRuntime(
    ConnectorOptions options,
    StructuredLog log,
    ConnectorObservationCollector collector,
    DeliveryPump pump,
    EncryptedSpool spool,
    TimeProvider timeProvider)
{
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        log.Info("connector.start", new Dictionary<string, object?>
        {
            ["connectorId"] = options.ConnectorId,
            ["targetId"] = options.TargetId,
            ["endpoint"] = options.IngestEndpoint.GetLeftPart(UriPartial.Path),
        });

        var collection = CollectionLoopAsync(cancellationToken);
        var delivery = DeliveryLoopAsync(cancellationToken);
        try
        {
            await Task.WhenAll(collection, delivery).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Requested shutdown still reaches the bounded final drain below.
        }
        finally
        {
            await FinalDrainAsync().ConfigureAwait(false);
            log.Info("connector.stopped", Status());
        }
    }

    private async Task CollectionLoopAsync(CancellationToken cancellationToken)
    {
        var consecutiveRejections = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var batch = await collector.CollectBatchAsync(
                    timeProvider.GetUtcNow(), cancellationToken).ConfigureAwait(false);
                if (batch is not null)
                {
                    var outcome = pump.Submit(batch);
                    if (outcome == SpoolEnqueueOutcome.RejectedBackpressure)
                    {
                        consecutiveRejections++;
                        var fields = Status();
                        fields["nextCollectSeconds"] = CollectDelay(options, consecutiveRejections).TotalSeconds;
                        log.Warn("connector.backpressure", fields);
                    }
                    else
                    {
                        consecutiveRejections = 0;
                        log.Info("connector.collected", new Dictionary<string, object?>
                        {
                            ["batchId"] = batch.BatchId,
                            ["chunks"] = batch.Envelopes.Count,
                        });
                    }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.Error("connector.collect_failed", new Dictionary<string, object?> { ["error"] = ex.GetType().Name });
            }

            if (!await DelayAsync(CollectDelay(options, consecutiveRejections), cancellationToken).ConfigureAwait(false))
                break;
        }
    }

    /// <summary>
    /// How long to wait before the next collection cycle. After a real spool rejection the cadence
    /// decays exponentially up to <see cref="ConnectorOptions.CollectBackoffMaxInterval"/>, so an
    /// outage stops costing the monitored SQL Server a full query/serialize/seal cycle every
    /// interval, while the connector keeps trying and recovers on its own once delivery drains space.
    /// <para>
    /// Collection is deliberately <b>not</b> gated on the pump's paused flag. That flag is set by a
    /// rejection and cleared only by a <i>successful enqueue</i> — never merely by delivery freeing
    /// space — so skipping collection while paused would suppress the very enqueue that clears it and
    /// the connector would never recover. Backoff decays the wasted work without that deadlock.
    /// </para>
    /// </summary>
    internal static TimeSpan CollectDelay(ConnectorOptions options, int consecutiveRejections)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (consecutiveRejections <= 0)
            return options.CollectInterval;

        var baseMs = options.CollectInterval.TotalMilliseconds;
        var ceilingMs = Math.Max(options.CollectBackoffMaxInterval.TotalMilliseconds, baseMs);
        var scaled = baseMs * Math.Pow(2, Math.Min(consecutiveRejections, 16));
        return TimeSpan.FromMilliseconds(Math.Min(scaled, ceilingMs));
    }

    private async Task DeliveryLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            TimeSpan delay;
            try
            {
                spool.PruneExpired();
                if (pump.AuthFaulted)
                {
                    log.Warn("connector.auth_faulted", Status());
                    delay = options.DeliverInterval;
                }
                else
                {
                    var summary = await pump.DrainOnceAsync(cancellationToken).ConfigureAwait(false);
                    if (summary.Delivered > 0 || summary.Dropped > 0 || summary.Split > 0)
                        log.Info("connector.delivered", DrainFields(summary));
                    if (summary.AuthFaulted)
                        log.Warn("connector.auth_faulted", Status());
                    delay = summary.SuggestedDelay ?? options.DeliverInterval;
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.Error("connector.deliver_failed", new Dictionary<string, object?> { ["error"] = ex.GetType().Name });
                delay = options.DeliverInterval;
            }

            if (!await DelayAsync(delay, cancellationToken).ConfigureAwait(false))
                break;
        }
    }

    private async Task FinalDrainAsync()
    {
        if (pump.AuthFaulted)
            return;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try
        {
            await pump.DrainOnceAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Bounded drain window elapsed; remaining batches stay safely spooled for the next run.
        }
        catch (Exception ex)
        {
            log.Warn("connector.final_drain_failed", new Dictionary<string, object?> { ["error"] = ex.GetType().Name });
        }
    }

    private async Task<bool> DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(delay, timeProvider, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    private Dictionary<string, object?> DrainFields(DrainSummary summary)
    {
        var fields = Status();
        fields["delivered"] = summary.Delivered;
        fields["dropped"] = summary.Dropped;
        fields["split"] = summary.Split;
        return fields;
    }

    private Dictionary<string, object?> Status()
    {
        var status = spool.GetStatus();
        return new Dictionary<string, object?>
        {
            ["spoolItems"] = status.ItemCount,
            ["spoolBytes"] = status.ByteCount,
            ["paused"] = status.Paused,
            ["droppedByAge"] = status.DroppedByAge,
            ["authFaulted"] = pump.AuthFaulted,
        };
    }
}
