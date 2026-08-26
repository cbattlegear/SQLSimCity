-- SQL Server 2022+ keyset runtime variant with replica groups.
-- The keyset predicate sits in the base WHERE, before GROUP BY, and deliberately not outside the
-- CTE. Measured (issue #81): filtering after the aggregate left logical reads flat at 843 from the
-- first page to the last while CPU fell, because every page re-aggregated the whole
-- @StartTime..@EndTime window -- the optimizer does not push this predicate below the aggregate on
-- its own. Cost was O(window) per page instead of O(page).
-- Moving it cannot change which groups come back: all four cursor columns are grouping columns, so
-- the predicate is constant across every row of a group and either keeps the group whole or drops
-- it whole. In particular the active interval's flushed and in-memory duplicate rows share that key,
-- so they are still summed together here and are never split or double-counted -- overlap replay
-- stays necessary for exactly the reason it was before.
-- The redundant leading `>= @AfterIntervalId` is implied by the OR chain (every branch requires it)
-- and exists to give the engine a single-column seekable predicate; the chain itself stays as the
-- exact residual.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

WITH buckets AS (
    SELECT
        rs.runtime_stats_interval_id, rs.plan_id, rs.execution_type, rs.replica_group_id,
        rsi.start_time, rsi.end_time,
        SUM(CONVERT(decimal(38,0), rs.count_executions)) AS execution_count,
        SUM(CONVERT(float, rs.avg_duration) * CONVERT(float, rs.count_executions))
          / NULLIF(SUM(CONVERT(float, rs.count_executions)), 0.0) AS average_duration_us,
        SUM(CONVERT(float, rs.avg_cpu_time) * CONVERT(float, rs.count_executions))
          / NULLIF(SUM(CONVERT(float, rs.count_executions)), 0.0) AS average_cpu_us,
        SUM(CONVERT(float, rs.avg_logical_io_reads) * CONVERT(float, rs.count_executions))
          / NULLIF(SUM(CONVERT(float, rs.count_executions)), 0.0) AS average_logical_reads_pages
    FROM sys.query_store_runtime_stats AS rs
    JOIN sys.query_store_runtime_stats_interval AS rsi
      ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id
    WHERE rsi.end_time > @StartTime AND rsi.start_time < @EndTime
      AND rs.runtime_stats_interval_id >= @AfterIntervalId
      AND (rs.runtime_stats_interval_id > @AfterIntervalId
           OR (rs.runtime_stats_interval_id = @AfterIntervalId AND rs.plan_id > @AfterPlanId)
           OR (rs.runtime_stats_interval_id = @AfterIntervalId AND rs.plan_id = @AfterPlanId
               AND rs.execution_type > @AfterExecutionType)
           OR (rs.runtime_stats_interval_id = @AfterIntervalId AND rs.plan_id = @AfterPlanId
               AND rs.execution_type = @AfterExecutionType
               AND rs.replica_group_id > @AfterReplicaGroupId))
    GROUP BY rs.runtime_stats_interval_id, rs.plan_id, rs.execution_type, rs.replica_group_id,
             rsi.start_time, rsi.end_time
)
SELECT TOP (@PageSize) *
FROM buckets
ORDER BY runtime_stats_interval_id, plan_id, execution_type, replica_group_id;
