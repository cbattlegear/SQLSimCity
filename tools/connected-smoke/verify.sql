SET NOCOUNT ON;
IF DB_NAME() <> N'SmokeCity' OR ORIGINAL_LOGIN() <> N'smoke_collector'
    THROW 51000, 'Verification did not use the collector in SmokeCity.', 1;
IF COALESCE(IS_SRVROLEMEMBER(N'sysadmin'), 1) <> 0
    OR COALESCE(IS_ROLEMEMBER(N'db_owner'), 1) <> 0
    OR HAS_PERMS_BY_NAME(NULL, NULL, 'CONTROL SERVER') <> 0
    OR HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CONTROL') <> 0
    THROW 51001, 'Collector has administrative privileges.', 1;
IF EXISTS (SELECT 1 FROM sys.database_role_members WHERE member_principal_id = USER_ID())
    THROW 51002, 'Collector unexpectedly belongs to a database role.', 1;
IF NOT EXISTS (SELECT 1 FROM sys.database_query_store_options
    WHERE actual_state_desc = N'READ_WRITE' AND query_capture_mode_desc = N'ALL')
    THROW 51003, 'Query Store is not writable with ALL capture.', 1;

DECLARE @denied bit = 0;
BEGIN TRY
    BEGIN TRANSACTION;
    EXEC(N'INSERT INTO commerce.entity_1 (id, tenant_id, code, label, amount)
        VALUES (-1, 0, ''forbidden'', N''forbidden'', 0);');
    ROLLBACK TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    IF ERROR_NUMBER() <> 229 THROW;
    SET @denied = 1;
END CATCH;
IF @denied <> 1
    THROW 51004, 'Collector write was not denied.', 1;

DECLARE @tables int = (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0);
DECLARE @rows bigint = (
    SELECT SUM(p.row_count) FROM sys.dm_db_partition_stats AS p
    JOIN sys.tables AS t ON t.object_id = p.object_id
    WHERE t.is_ms_shipped = 0 AND p.index_id IN (0, 1)
);
DECLARE @queries int, @joins int, @executions bigint, @projections int;
SELECT @queries = COUNT(DISTINCT q.query_id),
    @joins = COUNT(DISTINCT CASE WHEN t.query_sql_text LIKE N'% JOIN %' THEN q.query_id END),
    @projections = COUNT(DISTINCT CASE WHEN t.query_sql_text LIKE N'%smoke_projection[_]%' THEN q.query_id END),
    @executions = SUM(r.count_executions)
FROM sys.query_store_query AS q
JOIN sys.query_store_query_text AS t ON t.query_text_id = q.query_text_id
JOIN sys.query_store_plan AS p ON p.query_id = q.query_id
JOIN sys.query_store_runtime_stats AS r ON r.plan_id = p.plan_id
WHERE q.query_parameterization_type = 1
    AND t.query_sql_text LIKE N'%entity[_]%'
    AND r.execution_type = 0;
IF @tables <> 12 OR COALESCE(@rows, 0) < 6000
    THROW 51005, 'Seed tables are absent, unreadable, or empty.', 1;
IF COALESCE(@queries, 0) < 163 OR COALESCE(@joins, 0) < 139 OR COALESCE(@executions, 0) < 12905
    OR COALESCE(@projections, 0) < 128
    THROW 51006, 'Parameterized multi-table Query Store workload is missing.', 1;
SELECT CONCAT(N'SMOKE_VERIFIED ', @tables, N' ', @rows, N' ', @queries, N' ', @joins, N' ', @executions, N' ', @projections);
GO
