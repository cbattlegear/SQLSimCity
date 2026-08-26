-- Cycles Query Store off and on, then puts the settings back exactly as they were.
--
-- The cycle is not optional after 04-deep-history.sql. The engine's interval-id
-- counter does not read plan_persist_runtime_stats_interval -- measured: with id
-- 900001 already inserted the engine still allocated id 2 next -- so after
-- synthesizing intervals it will keep handing out ids that already exist and the
-- next rollover fails with a duplicate key inside Query Store's own clustered index.
-- Turning Query Store off and on makes it re-derive the counter from the persisted
-- maximum: measured, after the cycle the next interval it created was 900002.
--
-- The cycle also discards Query Store's in-memory state and reloads from disk, which
-- is what makes the verification afterwards worth reading. Without it the catalog
-- views would still be serving partly from memory, so a "120-day span" could be
-- reporting rows that only exist in this instance's RAM.
--
-- THE TRAP THIS SCRIPT EXISTS TO CLOSE
--
-- ALTER DATABASE ... SET QUERY_STORE = OFF then ON does not preserve the settings.
-- They revert to the server defaults, which means QUERY_CAPTURE_MODE goes back to
-- AUTO and INTERVAL_LENGTH_MINUTES back to 60 -- the exact two defaults this rig
-- exists to override, silently restored by the very operation that keeps the id
-- counter honest. Measured: after a cycle, a workload query ran to completion and
-- was not captured at all.
--
-- Rather than restate the settings here and let them drift from 01-database.sql,
-- this reads the live options first and replays them.

SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

DECLARE @operationMode nvarchar(60),
        @captureMode nvarchar(60),
        @sizeCleanup nvarchar(60),
        @waitCapture nvarchar(60),
        @intervalMinutes bigint,
        @maxSizeMb bigint,
        @staleDays bigint,
        @maxPlans bigint,
        @flushSeconds bigint;

SELECT @operationMode = desired_state_desc,
       @captureMode = query_capture_mode_desc,
       @sizeCleanup = size_based_cleanup_mode_desc,
       @waitCapture = wait_stats_capture_mode_desc,
       @intervalMinutes = interval_length_minutes,
       @maxSizeMb = max_storage_size_mb,
       @staleDays = stale_query_threshold_days,
       @maxPlans = max_plans_per_query,
       @flushSeconds = flush_interval_seconds
FROM sys.database_query_store_options;

IF @operationMode IS NULL
    THROW 51000, 'Query Store is not enabled on this database.', 1;

DECLARE @db sysname = DB_NAME();
DECLARE @sql nvarchar(max);

SET @sql = N'ALTER DATABASE ' + QUOTENAME(@db) + N' SET QUERY_STORE = OFF;';
EXEC sys.sp_executesql @sql;

SET @sql = N'ALTER DATABASE ' + QUOTENAME(@db) + N' SET QUERY_STORE = ON;';
EXEC sys.sp_executesql @sql;

SET @sql = N'ALTER DATABASE ' + QUOTENAME(@db) + N' SET QUERY_STORE (
    OPERATION_MODE = ' + @operationMode + N',
    QUERY_CAPTURE_MODE = ' + @captureMode + N',
    INTERVAL_LENGTH_MINUTES = ' + CONVERT(nvarchar(20), @intervalMinutes) + N',
    MAX_STORAGE_SIZE_MB = ' + CONVERT(nvarchar(20), @maxSizeMb) + N',
    SIZE_BASED_CLEANUP_MODE = ' + @sizeCleanup + N',
    CLEANUP_POLICY = (STALE_QUERY_THRESHOLD_DAYS = ' + CONVERT(nvarchar(20), @staleDays) + N'),
    MAX_PLANS_PER_QUERY = ' + CONVERT(nvarchar(20), @maxPlans) + N',
    WAIT_STATS_CAPTURE_MODE = ' + @waitCapture + N',
    DATA_FLUSH_INTERVAL_SECONDS = ' + CONVERT(nvarchar(20), @flushSeconds) + N');';
EXEC sys.sp_executesql @sql;

-- Prove the replay landed rather than assuming it. This compares against what was
-- read before the cycle, not against a hard-coded pair, so it still guards a rig
-- someone has reconfigured. A run that silently reverted to AUTO/60 here would make
-- every measurement taken afterwards a measurement of the wrong store.
IF NOT EXISTS (
    SELECT 1 FROM sys.database_query_store_options
    WHERE query_capture_mode_desc = @captureMode
      AND interval_length_minutes = @intervalMinutes
      AND stale_query_threshold_days = @staleDays)
    THROW 51000, 'Query Store settings did not survive the off/on cycle.', 1;

SELECT actual_state_desc,
       query_capture_mode_desc,
       interval_length_minutes,
       stale_query_threshold_days,
       max_storage_size_mb,
       current_storage_size_mb
FROM sys.database_query_store_options;
GO
