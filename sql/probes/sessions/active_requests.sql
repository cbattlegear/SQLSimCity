-- Probe: sessions.active_requests
-- Purpose: Live user sessions and their currently executing request (if any), with the currently
--   executing statement text resolved from the batch. Deliberately excludes any eager plan XML --
--   no CROSS/OUTER APPLY sys.dm_exec_query_plan here.
-- Connection scope: server (instance-wide; not filtered to the connected database unless the
--   caller supplies @DatabaseId).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: SQL Server 2019 (15.x) and earlier require VIEW SERVER STATE (or, on Azure SQL
--   Database, VIEW DATABASE STATE, which restricts visibility to the current database's own
--   sessions). SQL Server 2022 (16.x) and later require VIEW SERVER PERFORMANCE STATE.
-- Parameters:
--   @IncludeIdleSessions (bit, optional, default 0) -- when 0, only sessions with an active
--     request are returned; when 1, idle user sessions are included too.
--   @MinElapsedMs (int, optional, default 0) -- lower bound on total_elapsed_time for the request;
--     use to focus on long-running requests only.
--   @DatabaseId (int, optional, default NULL) -- when supplied, restricts active requests to their
--     request database and idle sessions to their current session database; NULL returns all
--     visible user sessions/requests.
--   @IncludeSqlText (bit, optional, default 1) -- when 0, no SQL text function is invoked and both
--     text columns are NULL. Edge collection uses 0 so raw SQL is never fetched or transmitted.
-- Result contract: zero or more rows, one per (session_id, request_id). current_statement_text is
--   the substring of the batch actually executing right now, resolved via statement offsets;
--   batch_text is the full submitted batch. Both are NULL for idle sessions with no sql_handle.
--   request_id IS NULL for an idle session with no currently executing request -- distinct from a
--   real, active request_id 0, which is an ordinary (not sentinel) value for a session's first or
--   only concurrently executing request. The application layer must never coerce a NULL
--   request_id into 0; see LiveIncidentCollector.MapActiveRequest.
--   request_status is likewise NULL for an idle session, and sys.dm_exec_requests.status is never
--   NULL for a request that exists, so a NULL request_status is positive evidence that the session
--   has no request rather than a request whose state went unreported. The application layer must
--   not substitute a synthetic status such as 'idle' for it: a consumer that counts rows with a
--   non-null request_status as running requests would then count idle sessions as concurrency.
--   database_id/database_name use the active request database when present and the session's
--   current database for an idle row, allowing a per-database atlas to count idle sessions without
--   assigning them to database zero or treating them as unknown.
-- Excludes the caller's own session (@@SPID): the collector's polling connection would otherwise
--   appear as a permanently "idle" or churning session in its own sample every cycle.
-- Relative cost: low; in-memory session/request state, no page or plan-cache scan.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    s.session_id,
    s.login_name,
    s.host_name,
    s.program_name,
    s.status                    AS session_status,
    s.last_request_start_time,
    s.last_request_end_time,
    r.request_id,
    r.status                    AS request_status,
    r.command,
    r.wait_type,
    r.wait_time                 AS wait_time_ms,
    r.wait_resource,
    r.blocking_session_id,      -- preserves sentinel values; see sql/README.md
    r.start_time                AS request_start_time,
    r.total_elapsed_time        AS total_elapsed_time_ms,
    r.cpu_time                  AS cpu_time_ms,
    r.reads,
    r.writes,
    r.logical_reads,            -- 8-KiB pages
    r.open_transaction_count,
    COALESCE(r.database_id, s.database_id) AS database_id,
    DB_NAME(COALESCE(r.database_id, s.database_id)) AS database_name,
    st.text                     AS batch_text,
    SUBSTRING(
        st.text,
        (r.statement_start_offset / 2) + 1,
        (
            (CASE r.statement_end_offset
                 WHEN -1 THEN DATALENGTH(st.text)
                 ELSE r.statement_end_offset
             END - r.statement_start_offset) / 2
        ) + 1
    )                            AS current_statement_text
FROM sys.dm_exec_sessions AS s
LEFT JOIN sys.dm_exec_requests AS r
    ON r.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(CASE WHEN @IncludeSqlText = 1 THEN r.sql_handle END) AS st
WHERE s.is_user_process = 1
  AND s.session_id <> @@SPID
  AND (@IncludeIdleSessions = 1 OR r.session_id IS NOT NULL)
  AND (r.request_id IS NULL OR r.total_elapsed_time >= @MinElapsedMs)
  AND (@DatabaseId IS NULL OR COALESCE(r.database_id, s.database_id) = @DatabaseId);
