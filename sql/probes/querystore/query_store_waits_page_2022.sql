-- SQL Server 2022+ keyset wait variant with replica groups.
-- The keyset predicate sits in the base WHERE, before GROUP BY, and deliberately not outside the
-- CTE. Measured (issue #81): filtering after the aggregate left logical reads flat from the first
-- page to the last, because every page re-aggregated the whole @StartTime..@EndTime window -- the
-- optimizer does not push this predicate below the aggregate on its own. Cost was O(window) per
-- page instead of O(page).
-- Moving it cannot change which groups come back: all five cursor columns are grouping columns, so
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
    SELECT ws.runtime_stats_interval_id, ws.plan_id, ws.execution_type, ws.wait_category,
           ws.wait_category_desc, ws.replica_group_id,
           SUM(CONVERT(decimal(38,0), ws.total_query_wait_time_ms)) AS total_wait_ms
    FROM sys.query_store_wait_stats AS ws
    JOIN sys.query_store_runtime_stats_interval AS rsi
      ON rsi.runtime_stats_interval_id = ws.runtime_stats_interval_id
    WHERE rsi.end_time > @StartTime AND rsi.start_time < @EndTime
      AND ws.runtime_stats_interval_id >= @AfterIntervalId
      AND (ws.runtime_stats_interval_id > @AfterIntervalId
           OR (ws.runtime_stats_interval_id = @AfterIntervalId AND ws.plan_id > @AfterPlanId)
           OR (ws.runtime_stats_interval_id = @AfterIntervalId AND ws.plan_id = @AfterPlanId
               AND ws.execution_type > @AfterExecutionType)
           OR (ws.runtime_stats_interval_id = @AfterIntervalId AND ws.plan_id = @AfterPlanId
               AND ws.execution_type = @AfterExecutionType
               AND ws.replica_group_id > @AfterReplicaGroupId)
           OR (ws.runtime_stats_interval_id = @AfterIntervalId AND ws.plan_id = @AfterPlanId
               AND ws.execution_type = @AfterExecutionType
               AND ws.replica_group_id = @AfterReplicaGroupId
               AND ws.wait_category > @AfterWaitCategory))
    GROUP BY ws.runtime_stats_interval_id, ws.plan_id, ws.execution_type,
             ws.wait_category, ws.wait_category_desc, ws.replica_group_id
)
SELECT TOP (@PageSize) *
FROM buckets
ORDER BY runtime_stats_interval_id, plan_id, execution_type, replica_group_id, wait_category;
