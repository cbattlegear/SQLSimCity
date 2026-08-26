using SqlSimCity.Edge.Connector;
using SqlSimCity.Edge.Delivery;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Spool;

namespace SqlSimCity.Edge.Tests;

public sealed class ConnectorRuntimeTests
{
    [Fact]
    public async Task RequestedShutdownStillRunsFinalSpoolDrain()
    {
        var root = Path.Combine(
            AppContext.BaseDirectory, "runtime-drain-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using var key = new SpoolKey(1, new byte[32]);
            var spool = new EncryptedSpool(
                new SpoolOptions { DataDirectory = root }, key);
            var transport = new FirstTransientTransport();
            var pump = new DeliveryPump(spool, transport);
            pump.Submit(EdgeTestSupport.SampleBatch());
            var options = new ConnectorOptions
            {
                ConnectorId = "connector",
                TargetId = "target",
                KeyId = "key",
                IngestEndpoint = new Uri("https://central.example/api/v1/edge/ingest"),
                SigningSecretFile = "signing",
                SpoolDirectory = root,
                SpoolKeyFile = "spool-key",
                FixturesDirectory = root,
                CollectInterval = TimeSpan.FromHours(1),
                DeliverInterval = TimeSpan.FromHours(1),
            };
            var collector = new ConnectorObservationCollector(
                options, new CancellableProvider(), "boot", "epoch");
            var runtime = new ConnectorRuntime(
                options, new StructuredLog(), collector, pump, spool, TimeProvider.System);
            using var cancellation = new CancellationTokenSource();
            var running = runtime.RunAsync(cancellation.Token);

            await transport.FirstCall.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await cancellation.CancelAsync();
            await running;

            Assert.Equal(2, transport.Calls);
            Assert.Equal(0, spool.GetStatus().ItemCount);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    /// <summary>
    /// Without collection backoff the loop re-queries, re-serializes, and re-seals a batch every
    /// cadence for the whole outage. The assertion is one-sided — elapsed time can only grow on a
    /// loaded machine — so it fails only when the backoff is genuinely absent.
    /// </summary>
    [Fact]
    public async Task CollectionCadenceDecaysWhileEveryBatchIsRejected()
    {
        var root = Path.Combine(
            AppContext.BaseDirectory, "runtime-cadence-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using var key = new SpoolKey(1, new byte[32]);
            var spool = new EncryptedSpool(
                new SpoolOptions { DataDirectory = root, MaxItems = 1 }, key);
            // Fill the spool and keep delivery down, so every collected batch is rejected.
            Assert.Equal(SpoolEnqueueOutcome.Accepted, spool.Enqueue(EdgeTestSupport.SampleBatch()));
            var pump = new DeliveryPump(spool, new NeverDeliversTransport(), new DeliveryPumpOptions
            {
                BaseRetryDelay = TimeSpan.FromSeconds(30),
                MaxRetryDelay = TimeSpan.FromSeconds(30),
            });
            var options = Options(root) with
            {
                CollectInterval = TimeSpan.FromMilliseconds(20),
                CollectBackoffMaxInterval = TimeSpan.FromSeconds(10),
                DeliverInterval = TimeSpan.FromSeconds(30),
            };
            var provider = new CountingProvider();
            var collector = new ConnectorObservationCollector(options, provider, "boot", "epoch");
            var runtime = new ConnectorRuntime(
                options, new StructuredLog(), collector, pump, spool, TimeProvider.System);
            using var cancellation = new CancellationTokenSource();

            var started = DateTimeOffset.UtcNow;
            var running = runtime.RunAsync(cancellation.Token);
            await WaitUntilAsync(() => provider.Collections >= 6, TimeSpan.FromSeconds(30));
            var elapsed = DateTimeOffset.UtcNow - started;
            await cancellation.CancelAsync();
            await running;

            // Six un-backed-off cycles would take about 6 x 20ms; backed off they take about 1.2s.
            Assert.True(
                elapsed >= TimeSpan.FromMilliseconds(500),
                $"Six rejected collections took only {elapsed.TotalMilliseconds:F0}ms, so the cadence never decayed.");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task CollectionBacksOffAfterSpoolBackpressureButNeverStops()
    {
        var root = Path.Combine(
            AppContext.BaseDirectory, "runtime-backpressure-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using var key = new SpoolKey(1, new byte[32]);
            // One item fits, so a second collection cycle is rejected for backpressure.
            var spool = new EncryptedSpool(
                new SpoolOptions { DataDirectory = root, MaxItems = 1 }, key);
            var transport = new BlockedThenAcceptingTransport();
            var pump = new DeliveryPump(spool, transport, new DeliveryPumpOptions
            {
                BaseRetryDelay = TimeSpan.FromMilliseconds(10),
                MaxRetryDelay = TimeSpan.FromMilliseconds(50),
            });
            var options = Options(root) with
            {
                CollectInterval = TimeSpan.FromMilliseconds(20),
                CollectBackoffMaxInterval = TimeSpan.FromMilliseconds(200),
                DeliverInterval = TimeSpan.FromMilliseconds(20),
            };
            var collector = new ConnectorObservationCollector(
                options, new CountingProvider(), "boot", "epoch");
            var runtime = new ConnectorRuntime(
                options, new StructuredLog(), collector, pump, spool, TimeProvider.System);
            using var cancellation = new CancellationTokenSource();
            var running = runtime.RunAsync(cancellation.Token);

            // Delivery is blocked, so the bounded spool fills and a collected batch is rejected.
            await WaitUntilAsync(() => spool.GetStatus().Paused, TimeSpan.FromSeconds(10));

            // Recovery is the point: once delivery drains, batches flow again with no operator action.
            transport.Unblock();
            await transport.SecondDelivery.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await cancellation.CancelAsync();
            await running;

            Assert.True(transport.Delivered >= 2, $"Delivered {transport.Delivered} batches.");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void CollectionCadenceDecaysOnlyWhileBackpressureIsBeingReported()
    {
        var options = Options("unused") with
        {
            CollectInterval = TimeSpan.FromSeconds(15),
            CollectBackoffMaxInterval = TimeSpan.FromMinutes(5),
        };

        Assert.Equal(options.CollectInterval, ConnectorRuntime.CollectDelay(options, 0));
        Assert.Equal(TimeSpan.FromSeconds(30), ConnectorRuntime.CollectDelay(options, 1));
        Assert.Equal(TimeSpan.FromSeconds(60), ConnectorRuntime.CollectDelay(options, 2));
        Assert.Equal(options.CollectBackoffMaxInterval, ConnectorRuntime.CollectDelay(options, 20));

        // A ceiling at or below the interval simply means no backoff — never a zero-length cycle.
        var noBackoff = options with { CollectBackoffMaxInterval = TimeSpan.Zero };
        Assert.Equal(noBackoff.CollectInterval, ConnectorRuntime.CollectDelay(noBackoff, 9));
    }

    /// <summary>
    /// The trap in issue #83: gating collection on the pump's paused flag deadlocks the connector.
    /// <see cref="SpoolStatus.Paused"/> is set by a rejection and cleared only by a <i>successful
    /// enqueue</i>, so a runtime that skips collection while paused suppresses the very enqueue that
    /// would clear it. This asserts recovery from exactly that state: the spool is already paused and
    /// completely full before the runtime starts, and the connector must still deliver and resume.
    /// </summary>
    [Fact]
    public async Task PausedSpoolStillCollectsSoTheConnectorRecoversWithoutOperatorAction()
    {
        var root = Path.Combine(
            AppContext.BaseDirectory, "runtime-paused-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using var key = new SpoolKey(1, new byte[32]);
            var spool = new EncryptedSpool(
                new SpoolOptions { DataDirectory = root, MaxItems = 1 }, key);
            Assert.Equal(SpoolEnqueueOutcome.Accepted, spool.Enqueue(EdgeTestSupport.SampleBatch()));
            Assert.Equal(
                SpoolEnqueueOutcome.RejectedBackpressure,
                spool.Enqueue(EdgeTestSupport.SampleBatch(sequence: 2)));
            Assert.True(spool.GetStatus().Paused);

            var transport = new CountingTransport();
            var pump = new DeliveryPump(spool, transport);
            var options = Options(root) with
            {
                CollectInterval = TimeSpan.FromMilliseconds(20),
                CollectBackoffMaxInterval = TimeSpan.FromMilliseconds(100),
                DeliverInterval = TimeSpan.FromMilliseconds(20),
            };
            var collector = new ConnectorObservationCollector(
                options, new CountingProvider(), "boot", "epoch");
            var runtime = new ConnectorRuntime(
                options, new StructuredLog(), collector, pump, spool, TimeProvider.System);
            using var cancellation = new CancellationTokenSource();
            var running = runtime.RunAsync(cancellation.Token);

            // A runtime that skipped collection while paused would never enqueue again, so the
            // freshly collected batches below would never exist and this would time out.
            await transport.Reached(3).WaitAsync(TimeSpan.FromSeconds(10));
            await cancellation.CancelAsync();
            await running;
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static async Task WaitUntilAsync(Func<bool> condition, TimeSpan timeout)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (condition())
                return;
            await Task.Delay(10);
        }

        Assert.Fail("Condition was not reached within the timeout.");
    }

    private static ConnectorOptions Options(string root) => new()
    {
        ConnectorId = "connector",
        TargetId = "target",
        KeyId = "key",
        IngestEndpoint = new Uri("https://central.example/api/v1/edge/ingest"),
        SigningSecretFile = "signing",
        SpoolDirectory = root,
        SpoolKeyFile = "spool-key",
        FixturesDirectory = root,
        CollectInterval = TimeSpan.FromHours(1),
        DeliverInterval = TimeSpan.FromHours(1),
    };

    private sealed class CancellableProvider : IObservationProvider
    {
        public async Task<IReadOnlyList<ObservationInput>> CollectAsync(
            DateTimeOffset now,
            CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return [];
        }
    }

    /// <summary>Produces one small, always-valid observation per cycle, and counts the cycles.</summary>
    private sealed class CountingProvider : IObservationProvider
    {
        private int _collections;

        public int Collections => Volatile.Read(ref _collections);

        public Task<IReadOnlyList<ObservationInput>> CollectAsync(
            DateTimeOffset now,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _collections);
            IReadOnlyList<ObservationInput> inputs =
            [
                new ObservationInput(
                    ObservationSection.Atlas,
                    new ObservationFreshnessV1(now, now, null),
                    new { hello = "world" }),
            ];
            return Task.FromResult(inputs);
        }
    }

    /// <summary>Delivery stays down for the whole test, so the spool never drains.</summary>
    private sealed class NeverDeliversTransport : IDeliveryTransport
    {
        public Task<DeliveryResponse> SendAsync(ObservationBatchV1 batch, CancellationToken cancellationToken)
            => Task.FromResult(new DeliveryResponse(DeliveryOutcome.Transient, TimeSpan.Zero));
    }

    /// <summary>Refuses delivery until unblocked, so the bounded spool fills and rejects a collection.</summary>
    private sealed class BlockedThenAcceptingTransport : IDeliveryTransport
    {
        private readonly Lock _gate = new();
        private volatile bool _blocked = true;
        private int _delivered;

        public TaskCompletionSource SecondDelivery { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int Delivered
        {
            get { lock (_gate) return _delivered; }
        }

        public void Unblock() => _blocked = false;

        public Task<DeliveryResponse> SendAsync(ObservationBatchV1 batch, CancellationToken cancellationToken)
        {
            if (_blocked)
                return Task.FromResult(new DeliveryResponse(DeliveryOutcome.Transient, TimeSpan.Zero));

            lock (_gate)
            {
                _delivered++;
                if (_delivered >= 2)
                    SecondDelivery.TrySetResult();
            }

            return Task.FromResult(DeliveryResponse.Accepted);
        }
    }

    /// <summary>Accepts everything and signals when a delivery count is reached.</summary>
    private sealed class CountingTransport : IDeliveryTransport
    {
        private readonly Lock _gate = new();
        private readonly Dictionary<int, TaskCompletionSource> _waiters = new();
        private int _delivered;

        public Task Reached(int count)
        {
            lock (_gate)
            {
                if (_delivered >= count)
                    return Task.CompletedTask;
                if (!_waiters.TryGetValue(count, out var waiter))
                {
                    waiter = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    _waiters[count] = waiter;
                }

                return waiter.Task;
            }
        }

        public Task<DeliveryResponse> SendAsync(ObservationBatchV1 batch, CancellationToken cancellationToken)
        {
            lock (_gate)
            {
                _delivered++;
                foreach (var (count, waiter) in _waiters)
                {
                    if (_delivered >= count)
                        waiter.TrySetResult();
                }
            }

            return Task.FromResult(DeliveryResponse.Accepted);
        }
    }

    private sealed class FirstTransientTransport : IDeliveryTransport
    {
        public TaskCompletionSource FirstCall { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int Calls { get; private set; }

        public Task<DeliveryResponse> SendAsync(
            ObservationBatchV1 batch,
            CancellationToken cancellationToken)
        {
            Calls++;
            if (Calls == 1)
            {
                FirstCall.TrySetResult();
                return Task.FromResult(new DeliveryResponse(
                    DeliveryOutcome.Transient, TimeSpan.FromHours(1)));
            }
            return Task.FromResult(DeliveryResponse.Accepted);
        }
    }
}
