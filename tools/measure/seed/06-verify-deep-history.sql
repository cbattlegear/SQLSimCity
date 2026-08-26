-- What the store actually contains, read back from the public catalog views.
--
-- The span query deliberately reads sys.query_store_runtime_stats_interval and not the
-- plan_persist_* internal tables the transform wrote to. A claim that the rig seeded
-- 120 days is only worth the query that proves it, and the query that proves it has
-- to be the one the collector itself would issue -- otherwise it is checking that the
-- write happened, not that the engine surfaces it.
--
-- Run over the dedicated admin connection (-S admin:<host>). Only the real-versus-
-- synthesized breakdown needs it; everything else works on an ordinary connection and
-- is left readable there on purpose.

SET NOCOUNT ON;
GO

SELECT
    COUNT(*)                                                        AS intervals,
    MIN(start_time)                                                 AS oldest_start,
    MAX(start_time)                                                 AS newest_start,
    DATEDIFF(day, MIN(start_time), MAX(start_time))                 AS span_days,
    DATEDIFF(day, MIN(start_time), SYSDATETIMEOFFSET())             AS oldest_age_days,
    -- 90 days is QueryStoreRetention.History, the horizon the sink enforces and the
    -- default the collector's initial lookback is capped at. Intervals counted here are
    -- the ones that only exist because this rig ran.
    SUM(CASE WHEN start_time < DATEADD(day, -90, SYSDATETIMEOFFSET()) THEN 1 ELSE 0 END)
                                                                    AS intervals_beyond_90d
FROM sys.query_store_runtime_stats_interval;
GO

-- Real versus synthesized, so nobody has to take the split on trust. The comment
-- column is only set by 04-deep-history.sql, and is only visible over the DAC.
IF OBJECT_ID('sys.plan_persist_runtime_stats_interval') IS NULL
    PRINT 'origin breakdown skipped: needs the dedicated admin connection (-S admin:<host>)';
ELSE
    SELECT
        CASE WHEN i.comment = N'sqlsimcity-measure:synthesized' THEN 'synthesized' ELSE 'engine' END AS origin,
        COUNT(*)          AS intervals,
        MIN(i.start_time) AS oldest_start,
        MAX(i.start_time) AS newest_start
    FROM sys.plan_persist_runtime_stats_interval AS i
    GROUP BY CASE WHEN i.comment = N'sqlsimcity-measure:synthesized' THEN 'synthesized' ELSE 'engine' END
    ORDER BY origin;
GO

-- Interval ids must run in the same order as interval times. The collector pages
-- runtime stats with a keyset over runtime_stats_interval_id inside a time window, so
-- a store whose ids run backwards against its timestamps is not the thing being
-- simulated, however convincing its span looks.
SELECT COUNT(*) AS id_time_order_violations
FROM (
    SELECT start_time,
           LAG(start_time) OVER (ORDER BY runtime_stats_interval_id) AS previous_start
    FROM sys.query_store_runtime_stats_interval
) AS ordered
WHERE previous_start IS NOT NULL AND start_time < previous_start;
GO

SELECT
    (SELECT COUNT(*) FROM sys.query_store_query)   AS queries,
    (SELECT COUNT(*) FROM sys.query_store_plan)    AS plans,
    (SELECT COUNT(*) FROM sys.query_store_runtime_stats) AS runtime_buckets,
    (SELECT COUNT(*) FROM sys.query_store_wait_stats)    AS wait_buckets,
    (SELECT MIN(initial_compile_start_time) FROM sys.query_store_query) AS oldest_compile,
    (SELECT MAX(last_execution_time) FROM sys.query_store_query)        AS newest_execution;
GO
