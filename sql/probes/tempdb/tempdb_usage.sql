-- Probe: tempdb.usage
-- Purpose: tempdb space usage broken down by file, session, and task -- for spotting a runaway
--   session/task before tempdb fills up.
-- Connection scope: tempdb, EXPLICITLY. Unlike most probes in this catalog, the client must open
--   (or switch, via a fresh connection from the pool) its connection with tempdb as the current
--   database before running this file. sys.dm_db_file_space_usage returns space usage for
--   whichever database is current, so it must be run while connected to tempdb to get tempdb's
--   breakdown; sys.dm_db_session_space_usage and sys.dm_db_task_space_usage report only tempdb
--   allocations regardless of the current database, but are grouped here with the tempdb-context
--   requirement for a single, unambiguous connection-scope contract.
-- Azure SQL Database: NOT SUPPORTED through this probe. A connection string cannot target "tempdb"
--   as its initial catalog on Azure SQL Database -- tempdb is not one of the databases a login can
--   connect to directly on the logical server, unlike SQL Server and SQL Managed Instance, where a
--   fresh pooled connection can open with tempdb as its current database. Each Azure SQL Database
--   does have its own private, per-database tempdb, but this probe's tempdb-scoped connection
--   pattern cannot reach it. The session/task allocation views are also documented as applicable
--   only to tempdb, so querying them from a regular Azure SQL Database connection is not a valid
--   substitute. LiveIncidentCollector reports this evidence as Unsupported on Azure SQL Database.
-- Minimum platform: SQL Server 2016 (13.x) and SQL Managed Instance only.
-- Permission: sys.dm_db_file_space_usage / sys.dm_db_session_space_usage / sys.dm_db_task_space_usage
--   on SQL Server/Managed Instance require VIEW SERVER STATE (SQL Server 2016-2019 (13.x-15.x)) or
--   VIEW SERVER PERFORMANCE STATE (SQL Server 2022 (16.x)+).
-- Parameters:
--   @IncludeSystemSessions (bit, optional, default 0) -- when 0, session_id <= 50 (system
--     sessions) are excluded from the session/task result sets.
--   @MaxSessionRows (int, optional, default NULL) -- when supplied, result set 2 returns at most
--     this many sessions, the heaviest tempdb allocators first. NULL returns every row.
--   @MaxTaskRows (int, optional, default NULL) -- when supplied, result set 3 returns at most this
--     many tasks, the heaviest tempdb allocators first. NULL returns every row.
-- Result contract: THREE result sets, in this order -- (1) one row per tempdb data file from
--   sys.dm_db_file_space_usage, (2) one row per session from sys.dm_db_session_space_usage, and
--   (3) one row per task from sys.dm_db_task_space_usage. Consume via NextResult(); page counts are
--   8-KiB pages, converted here to MiB.
-- Bounding, and why it is disclosed rather than silent: these two views return one row per session
--   and one row per task whether or not that session ever touched tempdb, so they grow with the
--   instance's connection count and not with its tempdb activity. Measured against SQL Server 2022
--   (tools/measure), 5,028 sessions produced 1.76 MiB of session/task rows in a single live
--   snapshot -- the largest component of it, and almost all of it zero counters. The cap keeps the
--   heaviest allocators, which is exactly what "spot a runaway session before tempdb fills up"
--   needs, and visible_session_count / visible_task_count report how many rows existed before it
--   applied so a bounded result is never read as a quieter instance.
-- Relative cost: low; in-memory allocation counters, no page scan.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

-- Result set 1: tempdb file-level space usage (requires current database = tempdb).
SELECT
    fs.database_id,
    fs.file_id,
    fs.filegroup_id,
    fs.total_page_count * 8.0 / 1024.0                  AS total_mb,
    fs.allocated_extent_page_count * 8.0 / 1024.0        AS allocated_mb,
    fs.unallocated_extent_page_count * 8.0 / 1024.0      AS free_mb,
    fs.version_store_reserved_page_count * 8.0 / 1024.0  AS version_store_mb,
    fs.user_object_reserved_page_count * 8.0 / 1024.0    AS user_objects_mb,
    fs.internal_object_reserved_page_count * 8.0 / 1024.0 AS internal_objects_mb,
    fs.mixed_extent_page_count * 8.0 / 1024.0            AS mixed_extent_mb
FROM sys.dm_db_file_space_usage AS fs;

-- Result set 2: per-session tempdb page allocation/deallocation.
WITH sessions_visible AS (
    SELECT
        ss.session_id,
        ss.database_id,
        ss.user_objects_alloc_page_count,
        ss.user_objects_dealloc_page_count,
        ss.internal_objects_alloc_page_count,
        ss.internal_objects_dealloc_page_count,
        COUNT(*) OVER ()            AS visible_session_count,
        ROW_NUMBER() OVER (
            ORDER BY
                ss.user_objects_alloc_page_count + ss.internal_objects_alloc_page_count DESC,
                ss.session_id)      AS selection_rank
    FROM sys.dm_db_session_space_usage AS ss
    WHERE @IncludeSystemSessions = 1 OR ss.session_id > 50
)
SELECT
    v.session_id,
    v.database_id,
    v.user_objects_alloc_page_count,
    v.user_objects_dealloc_page_count,
    v.internal_objects_alloc_page_count,
    v.internal_objects_dealloc_page_count,
    v.visible_session_count
FROM sessions_visible AS v
WHERE @MaxSessionRows IS NULL OR v.selection_rank <= @MaxSessionRows;

-- Result set 3: per-task tempdb page allocation/deallocation (exec_context_id preserved for
-- parallel requests).
WITH tasks_visible AS (
    SELECT
        ts.session_id,
        ts.request_id,
        ts.exec_context_id,
        ts.database_id,
        ts.user_objects_alloc_page_count,
        ts.user_objects_dealloc_page_count,
        ts.internal_objects_alloc_page_count,
        ts.internal_objects_dealloc_page_count,
        COUNT(*) OVER ()            AS visible_task_count,
        ROW_NUMBER() OVER (
            ORDER BY
                ts.user_objects_alloc_page_count + ts.internal_objects_alloc_page_count DESC,
                ts.session_id,
                ts.exec_context_id) AS selection_rank
    FROM sys.dm_db_task_space_usage AS ts
    WHERE @IncludeSystemSessions = 1 OR ts.session_id > 50
)
SELECT
    v.session_id,
    v.request_id,
    v.exec_context_id,
    v.database_id,
    v.user_objects_alloc_page_count,
    v.user_objects_dealloc_page_count,
    v.internal_objects_alloc_page_count,
    v.internal_objects_dealloc_page_count,
    v.visible_task_count
FROM tasks_visible AS v
WHERE @MaxTaskRows IS NULL OR v.selection_rank <= @MaxTaskRows;
