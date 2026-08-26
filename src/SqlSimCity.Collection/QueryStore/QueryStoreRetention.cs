namespace SqlSimCity.Collection.QueryStore;

/// <summary>
/// The horizon retained history actually covers, shared so that what the collector reads and what
/// the sink keeps cannot drift apart. Reading further back than <see cref="History"/> puts load on
/// a production instance to gather evidence the first prune discards, which is why it also bounds
/// the collector's initial lookback.
/// </summary>
public static class QueryStoreRetention
{
    /// <summary>How far back normalized facts and hourly rollups are kept.</summary>
    public static readonly TimeSpan History = TimeSpan.FromDays(90);

    /// <summary>How far back per-interval runtime detail is kept before it is rolled up hourly.</summary>
    public static readonly TimeSpan Detail = TimeSpan.FromDays(7);
}
