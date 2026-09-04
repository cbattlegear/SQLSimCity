SET NOCOUNT ON;
USE [master];
GO
-- This script is only sent to the new, unpublished SQL container, never an operator target.
CREATE DATABASE [SmokeCity];
GO
ALTER DATABASE [SmokeCity] SET RECOVERY SIMPLE;
ALTER DATABASE [SmokeCity] SET QUERY_STORE = ON (
    OPERATION_MODE = READ_WRITE,
    QUERY_CAPTURE_MODE = ALL,
    INTERVAL_LENGTH_MINUTES = 1,
    DATA_FLUSH_INTERVAL_SECONDS = 60,
    MAX_STORAGE_SIZE_MB = 128
);
GO
CREATE LOGIN [smoke_collector] WITH PASSWORD = '__COLLECTOR_PASSWORD__',
    DEFAULT_DATABASE = [SmokeCity], CHECK_POLICY = ON;
GRANT VIEW SERVER PERFORMANCE STATE TO [smoke_collector];
GO
USE [SmokeCity];
GO
CREATE USER [smoke_collector] FOR LOGIN [smoke_collector];
GRANT CONNECT TO [smoke_collector];
GRANT VIEW DATABASE PERFORMANCE STATE TO [smoke_collector];
GRANT VIEW DEFINITION TO [smoke_collector];
GRANT VIEW SECURITY DEFINITION TO [smoke_collector];
-- No datareader, datawriter, db_owner, or server-role membership. Even data SELECT is absent.
DENY INSERT, UPDATE, DELETE, EXECUTE, ALTER, TAKE OWNERSHIP TO [smoke_collector];
GO
CREATE SCHEMA [commerce];
GO
CREATE SCHEMA [inventory];
GO
CREATE SCHEMA [operations];
GO
DECLARE @i int = 1, @schema sysname, @table sysname, @sql nvarchar(max);
WHILE @i <= 12
BEGIN
    SET @schema = CASE @i % 3 WHEN 1 THEN N'commerce' WHEN 2 THEN N'inventory' ELSE N'operations' END;
    SET @table = CONCAT(N'entity_', @i);
    SET @sql = N'CREATE TABLE ' + QUOTENAME(@schema) + N'.' + QUOTENAME(@table) + N' (
        id int NOT NULL PRIMARY KEY,
        tenant_id int NOT NULL,
        code varchar(32) NOT NULL,
        label nvarchar(240) NOT NULL,
        amount decimal(18,4) NOT NULL
    );
    CREATE INDEX ' + QUOTENAME(N'ix_' + @table + N'_tenant') + N' ON ' +
        QUOTENAME(@schema) + N'.' + QUOTENAME(@table) + N' (tenant_id) INCLUDE (code);
    INSERT INTO ' + QUOTENAME(@schema) + N'.' + QUOTENAME(@table) + N'
    SELECT TOP (' + CAST(@i * 80 AS nvarchar(10)) + N')
        ROW_NUMBER() OVER (ORDER BY a.object_id, a.column_id),
        a.column_id % 8, CONCAT(''C'', a.column_id),
        REPLICATE(N''usable seed '', ' + CAST(@i AS nvarchar(10)) + N'),
        a.column_id * 1.25
    FROM sys.all_columns AS a
    ORDER BY a.object_id, a.column_id;';
    EXEC sys.sp_executesql @sql;
    SET @i += 1;
END
GO
DECLARE @i int = 1, @pass int = 1, @schema sysname, @otherSchema sysname,
    @qualified nvarchar(300), @other nvarchar(300), @sql nvarchar(max);
WHILE @pass <= 3
BEGIN
    SET @i = 1;
    WHILE @i <= 12
    BEGIN
        SET @schema = CASE @i % 3 WHEN 1 THEN N'commerce' WHEN 2 THEN N'inventory' ELSE N'operations' END;
        SET @qualified = QUOTENAME(@schema) + N'.' + QUOTENAME(CONCAT(N'entity_', @i));
        SET @sql = N'SELECT TOP (5) id, code FROM ' + @qualified +
            N' WHERE tenant_id = @tenant ORDER BY id DESC;';
        EXEC sys.sp_executesql @sql, N'@tenant int', @tenant = @pass;
        SET @sql = N'SELECT tenant_id, SUM(amount) AS total FROM ' + @qualified +
            N' WHERE amount > @floor GROUP BY tenant_id;';
        EXEC sys.sp_executesql @sql, N'@floor decimal(18,4)', @floor = 10.0;
        IF @i > 1
        BEGIN
            SET @otherSchema = CASE (@i - 1) % 3 WHEN 1 THEN N'commerce' WHEN 2 THEN N'inventory' ELSE N'operations' END;
            SET @other = QUOTENAME(@otherSchema) + N'.' + QUOTENAME(CONCAT(N'entity_', @i - 1));
            SET @sql = N'SELECT TOP (5) l.id, r.code FROM ' + @qualified +
                N' AS l JOIN ' + @other + N' AS r ON r.id = l.id WHERE l.tenant_id = @tenant;';
            EXEC sys.sp_executesql @sql, N'@tenant int', @tenant = @pass;
        END
        SET @i += 1;
    END
    SET @pass += 1;
END
GO
-- Aliases survive normalization. Every weighted family is a join, so neither
-- collector probes nor the continuation workload itself crowd routes out of top-40.
DECLARE @projection int = 1, @repeat int, @entity int, @otherEntity int,
    @schema sysname, @otherSchema sysname, @sql nvarchar(max);
WHILE @projection <= 128
BEGIN
    SET @entity = ((@projection - 1) % 12) + 1;
    SET @otherEntity = (@entity % 12) + 1;
    SET @schema = CASE @entity % 3 WHEN 1 THEN N'commerce' WHEN 2 THEN N'inventory' ELSE N'operations' END;
    SET @otherSchema = CASE @otherEntity % 3 WHEN 1 THEN N'commerce' WHEN 2 THEN N'inventory' ELSE N'operations' END;
    SET @sql = N'SELECT l.tenant_id AS smoke_projection_' + CAST(@projection AS nvarchar(10)) +
        N', SUM(l.amount + r.amount) AS total FROM ' + QUOTENAME(@schema) + N'.' +
        QUOTENAME(CONCAT(N'entity_', @entity)) + N' AS l JOIN ' + QUOTENAME(@otherSchema) + N'.' +
        QUOTENAME(CONCAT(N'entity_', @otherEntity)) + N' AS r ON r.id = l.id
        WHERE l.tenant_id = @tenant GROUP BY l.tenant_id;';
    SET @repeat = 1;
    WHILE @repeat <= 100
    BEGIN
        EXEC sys.sp_executesql @sql, N'@tenant int', @tenant = 1;
        SET @repeat += 1;
    END
    SET @projection += 1;
END
EXEC sys.sp_query_store_flush_db;
GO
