-- Stretches a freshly seeded Query Store across a span of days, so the rig can
-- exercise behaviour that only engages on history older than the 90-day horizon.
--
-- WHY THIS EXISTS, AND WHY IT IS NOT A CLOCK TRICK
--
-- sys.query_store_runtime_stats_interval.start_time is stamped by the engine, so
-- the obvious way to seed months of history is to run the workload with the
-- container's clock in the past. That does not work, and the failure is silent:
-- SQL Server on Linux runs the engine inside SQLPAL, which does not take its time
-- through the glibc symbols LD_PRELOAD can interpose. libfaketime loads into
-- sqlservr -- it shows up in `ldd /opt/mssql/bin/sqlservr` -- and the engine goes
-- on reporting the real date anyway. Measured: with FAKETIME=-120d the container's
-- `date` moved 120 days but SYSDATETIME() and the error log did not move at all.
-- See tools/measure/README.md for the rest of the routes and why they were rejected.
--
-- So this script does not move any clock. It relabels the timeline of history the
-- engine really produced, by writing to Query Store's backing internal tables over
-- the dedicated admin connection. Every runtime-stats row here was produced by a
-- real execution of a real plan; only when it happened is rewritten.
--
-- THE TWO CONSTRAINTS THAT SHAPE THE TRANSFORM
--
-- 1. Interval ids must stay ordered by time. The collector pages runtime stats with
--    a keyset over runtime_stats_interval_id inside a time window, so a store whose
--    ids run backwards against its timestamps is not the thing being simulated.
--    Real intervals are therefore back-dated to the OLD end of the span and the
--    synthesized ones fill forward from them, keeping id order and time order the
--    same relation the engine would have produced.
--
-- 2. The engine's interval-id counter does not read this table. Measured: with
--    interval 900001 already inserted, the next interval the engine created was id
--    2, and a later insert of id 4 failed with a duplicate key on
--    plan_persist_runtime_stats_interval_cidx because the engine had already taken
--    it. Synthesized ids therefore have to sit above every id the engine will
--    allocate, AND the caller has to cycle QUERY_STORE OFF/ON afterwards, which is
--    what makes the engine re-derive the counter from the persisted maximum.
--    Add-DeepHistory.ps1 does that cycle. Running this script without it leaves a
--    store that works until the next interval rolls over and then collides.
--
-- Requires: the dedicated admin connection (-S admin:<host>), and a caller that has
-- already run EXEC sys.sp_query_store_flush_db so the history is on disk rather than
-- still in memory.

SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

DECLARE @spanDays int = $(SpanDays);
DECLARE @targetIntervals int = $(IntervalCount);
DECLARE @intervalMinutes int = $(IntervalLengthMinutes);
DECLARE @tag nvarchar(128) = N'sqlsimcity-measure:synthesized';

IF @spanDays < 1 THROW 51000, 'SpanDays must be at least 1.', 1;
IF @intervalMinutes < 1 THROW 51000, 'IntervalLengthMinutes must be at least 1.', 1;

DECLARE @realCount int =
    (SELECT COUNT(*) FROM sys.plan_persist_runtime_stats_interval);
IF @realCount = 0
    THROW 51000, 'No persisted runtime-stats intervals. Run the workload and EXEC sys.sp_query_store_flush_db first.', 1;

-- Refusing to run twice matters more than convenience: a second pass would treat
-- already-synthesized intervals as templates and compound the relabelling.
IF EXISTS (SELECT 1 FROM sys.plan_persist_runtime_stats_interval WHERE comment = @tag)
    THROW 51000, 'This database already carries synthesized deep history. Re-seed from scratch to change the span.', 1;

IF @targetIntervals < @realCount SET @targetIntervals = @realCount;

DECLARE @now datetimeoffset(7) = SYSDATETIMEOFFSET();
DECLARE @origin datetimeoffset(7) = DATEADD(day, -@spanDays, @now);
DECLARE @stepSeconds int = (@spanDays * 86400) / @targetIntervals;

IF @stepSeconds < @intervalMinutes * 60
    THROW 51000, 'IntervalCount is too high for SpanDays: the slots would overlap.', 1;

DECLARE @maxIntervalId bigint =
    (SELECT MAX(runtime_stats_interval_id) FROM sys.plan_persist_runtime_stats_interval);

-- One row per interval the finished store should have: where it sits on the new
-- timeline, and which real interval it copies its runtime stats from.
CREATE TABLE #slots (
    seq int NOT NULL PRIMARY KEY,
    interval_id bigint NOT NULL,
    is_new bit NOT NULL,
    template_interval_id bigint NOT NULL,
    start_time datetimeoffset(7) NOT NULL,
    end_time datetimeoffset(7) NOT NULL
);

WITH real_ordered AS (
    SELECT runtime_stats_interval_id,
           CONVERT(int, ROW_NUMBER() OVER (ORDER BY start_time, runtime_stats_interval_id)) - 1 AS seq
    FROM sys.plan_persist_runtime_stats_interval
)
INSERT #slots (seq, interval_id, is_new, template_interval_id, start_time, end_time)
SELECT seq,
       runtime_stats_interval_id,
       0,
       runtime_stats_interval_id,
       DATEADD(second, seq * @stepSeconds, @origin),
       DATEADD(minute, @intervalMinutes, DATEADD(second, seq * @stepSeconds, @origin))
FROM real_ordered;

-- Synthesized slots take ids above every real one and copy templates round-robin,
-- so the metrics vary across the span instead of one bucket repeated N times.
WITH numbers AS (
    SELECT TOP (@targetIntervals - @realCount)
           @realCount + CONVERT(int, ROW_NUMBER() OVER (ORDER BY (SELECT NULL))) - 1 AS seq
    FROM sys.all_columns AS a CROSS JOIN sys.all_columns AS b
),
templates AS (
    SELECT runtime_stats_interval_id,
           CONVERT(int, ROW_NUMBER() OVER (ORDER BY start_time, runtime_stats_interval_id)) - 1 AS ord
    FROM sys.plan_persist_runtime_stats_interval
)
INSERT #slots (seq, interval_id, is_new, template_interval_id, start_time, end_time)
SELECT n.seq,
       @maxIntervalId + (n.seq - @realCount) + 1,
       1,
       t.runtime_stats_interval_id,
       DATEADD(second, n.seq * @stepSeconds, @origin),
       DATEADD(minute, @intervalMinutes, DATEADD(second, n.seq * @stepSeconds, @origin))
FROM numbers AS n
JOIN templates AS t ON t.ord = (n.seq - @realCount) % @realCount;

-- 1. Move the real intervals to the old end of the span.
UPDATE i
SET start_time = s.start_time,
    end_time = s.end_time
FROM sys.plan_persist_runtime_stats_interval AS i
JOIN #slots AS s ON s.interval_id = i.runtime_stats_interval_id AND s.is_new = 0;

-- 2. Their runtime-stats rows carry their own execution timestamps, which would
--    otherwise still read "a few minutes ago" against an interval months old.
UPDATE rs
SET first_execution_time = s.start_time,
    last_execution_time = s.end_time
FROM sys.plan_persist_runtime_stats_v2 AS rs
JOIN #slots AS s ON s.interval_id = rs.runtime_stats_interval_id AND s.is_new = 0;

UPDATE rs
SET first_execution_time = s.start_time,
    last_execution_time = s.end_time
FROM sys.plan_persist_runtime_stats AS rs
JOIN #slots AS s ON s.interval_id = rs.runtime_stats_interval_id AND s.is_new = 0;

-- 3. The synthesized intervals themselves, tagged so they can be told apart from
--    the real ones by anyone reading this store later.
INSERT sys.plan_persist_runtime_stats_interval (runtime_stats_interval_id, start_time, end_time, comment)
SELECT interval_id, start_time, end_time, @tag
FROM #slots
WHERE is_new = 1;

-- 4. Replicate the runtime- and wait-stats rows into them. The column lists are
--    wide and version-dependent, so they are read from sys.columns rather than
--    written out: a hand-maintained list would rot on the next SQL Server release
--    and the failure would be a missing column, not a wrong one.
DECLARE @tables TABLE (name sysname NOT NULL, id_column sysname NOT NULL, ord int NOT NULL);
INSERT @tables (name, id_column, ord) VALUES
    ('plan_persist_runtime_stats_v2', 'runtime_stats_id', 1),
    ('plan_persist_runtime_stats',    'runtime_stats_id', 2),
    ('plan_persist_wait_stats_v2',    'wait_stats_id',    3),
    ('plan_persist_wait_stats',       'wait_stats_id',    4);

DECLARE @tableName sysname, @idColumn sysname, @objectId int, @baseId bigint;
DECLARE @columns nvarchar(max), @projection nvarchar(max), @sql nvarchar(max), @copied int;

DECLARE table_cursor CURSOR LOCAL FAST_FORWARD FOR
    SELECT name, id_column FROM @tables ORDER BY ord;
OPEN table_cursor;
FETCH NEXT FROM table_cursor INTO @tableName, @idColumn;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @objectId = OBJECT_ID(N'sys.' + @tableName);
    IF @objectId IS NOT NULL
    BEGIN
        SET @columns =
            (SELECT STRING_AGG(QUOTENAME(c.name), N',') WITHIN GROUP (ORDER BY c.column_id)
             FROM sys.columns AS c WHERE c.object_id = @objectId AND c.is_computed = 0);

        SET @projection =
            (SELECT STRING_AGG(
                CASE
                    WHEN c.name = @idColumn
                        THEN N'@baseId + ROW_NUMBER() OVER (ORDER BY s.seq, src.' + QUOTENAME(@idColumn) + N')'
                    WHEN c.name = 'runtime_stats_interval_id' THEN N's.interval_id'
                    WHEN c.name = 'first_execution_time' THEN N's.start_time'
                    WHEN c.name = 'last_execution_time' THEN N's.end_time'
                    ELSE N'src.' + QUOTENAME(c.name)
                END, N',') WITHIN GROUP (ORDER BY c.column_id)
             FROM sys.columns AS c WHERE c.object_id = @objectId AND c.is_computed = 0);

        SET @sql = N'SELECT @out = ISNULL(MAX(' + QUOTENAME(@idColumn) + N'), 0) FROM sys.' + QUOTENAME(@tableName) + N';';
        EXEC sys.sp_executesql @sql, N'@out bigint OUTPUT', @out = @baseId OUTPUT;

        SET @sql = N'INSERT INTO sys.' + QUOTENAME(@tableName) + N' (' + @columns + N')
                     SELECT ' + @projection + N'
                     FROM #slots AS s
                     JOIN sys.' + QUOTENAME(@tableName) + N' AS src
                       ON src.runtime_stats_interval_id = s.template_interval_id
                     WHERE s.is_new = 1;';
        EXEC sys.sp_executesql @sql, N'@baseId bigint', @baseId = @baseId;
        SET @copied = @@ROWCOUNT;
        IF @copied > 0 PRINT CONCAT('  ', @tableName, ': ', @copied, ' rows replicated');
    END
    FETCH NEXT FROM table_cursor INTO @tableName, @idColumn;
END
CLOSE table_cursor;
DEALLOCATE table_cursor;

-- 5. Plans and queries carry compile and last-execution timestamps of their own. A
--    plan "first compiled four minutes ago" with runtime stats from four months ago
--    is the kind of internally inconsistent store that makes a measurement worthless,
--    so these are derived from the intervals the plan actually appears in rather than
--    set to a flat constant.
WITH plan_span AS (
    SELECT rs.plan_id, MIN(i.start_time) AS first_seen, MAX(i.end_time) AS last_seen
    FROM sys.plan_persist_runtime_stats_v2 AS rs
    JOIN sys.plan_persist_runtime_stats_interval AS i
      ON i.runtime_stats_interval_id = rs.runtime_stats_interval_id
    GROUP BY rs.plan_id
)
UPDATE p
SET initial_compile_start_time = ps.first_seen,
    last_compile_start_time = ps.first_seen,
    last_execution_time = ps.last_seen
FROM sys.plan_persist_plan AS p
JOIN plan_span AS ps ON ps.plan_id = p.plan_id;

WITH query_span AS (
    SELECT p.query_id, MIN(p.initial_compile_start_time) AS first_seen, MAX(p.last_execution_time) AS last_seen
    FROM sys.plan_persist_plan AS p
    -- Plans that were never executed keep whatever timestamps they had; including them
    -- would feed a NULL into the aggregate and, for a query whose plans are all like
    -- that, write that NULL back over a real last_execution_time.
    WHERE p.last_execution_time IS NOT NULL
    GROUP BY p.query_id
)
UPDATE q
SET initial_compile_start_time = qs.first_seen,
    last_compile_start_time = qs.first_seen,
    last_execution_time = qs.last_seen
FROM sys.plan_persist_query AS q
JOIN query_span AS qs ON qs.query_id = q.query_id;

DROP TABLE #slots;
GO
