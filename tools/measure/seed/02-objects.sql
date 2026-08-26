-- Generates enough catalog objects to exercise the city's paging behaviour.
--
-- The browser automatically walks up to AUTO_PAGE_LIMIT (80) pages of
-- CITY_PAGE_SIZE (50) objects, so a database has to exceed 4,000 objects before
-- that ceiling is reachable at all. Below it, every measurement of the automatic
-- backfill measures a database that finishes early and proves nothing about the
-- case the issue is about.
--
-- Objects are spread across several schemas because schemas are drawn as
-- neighbourhoods, and a single-schema database exercises none of that layout.

SET NOCOUNT ON;
GO

USE [$(DatabaseName)];
GO

-- Schemas. EXEC() accepts a concatenation of literals and variables but not
-- function calls, so each statement is built into a variable first.
DECLARE @schemaCount int = $(SchemaCount);
DECLARE @i int = 1;
DECLARE @schema sysname;
DECLARE @sql nvarchar(max);

WHILE @i <= @schemaCount
BEGIN
    SET @schema = CONCAT('app', @i);
    IF SCHEMA_ID(@schema) IS NULL
    BEGIN
        SET @sql = N'CREATE SCHEMA ' + QUOTENAME(@schema) + N';';
        EXEC sys.sp_executesql @sql;
    END
    SET @i += 1;
END
GO

DECLARE @tableCount int = $(TableCount);
DECLARE @schemaCount int = $(SchemaCount);
DECLARE @i int = 1;
DECLARE @schema sysname;
DECLARE @table sysname;
DECLARE @qualified nvarchar(300);
DECLARE @sql nvarchar(max);

WHILE @i <= @tableCount
BEGIN
    SET @schema = CONCAT('app', ((@i - 1) % @schemaCount) + 1);
    SET @table = CONCAT('entity_', @i);
    SET @qualified = QUOTENAME(@schema) + N'.' + QUOTENAME(@table);

    -- Varying row width and index shape keeps the page counts that size the
    -- buildings from being uniform, which is what the city actually encodes.
    SET @sql = N'
CREATE TABLE ' + @qualified + N' (
    id            int            NOT NULL IDENTITY(1,1),
    tenant_id     int            NOT NULL,
    code          varchar(32)    NOT NULL,
    label         nvarchar(' + CAST(64 + (@i % 4) * 64 AS nvarchar(8)) + N') NULL,
    amount        decimal(18,4)  NULL,
    created_at    datetime2(3)   NOT NULL CONSTRAINT ' +
        QUOTENAME(N'df_' + @schema + N'_' + @table) + N' DEFAULT SYSUTCDATETIME(),
    CONSTRAINT ' + QUOTENAME(N'pk_' + @schema + N'_' + @table) + N' PRIMARY KEY CLUSTERED (id)
);';
    EXEC sys.sp_executesql @sql;

    SET @sql = N'CREATE NONCLUSTERED INDEX ' + QUOTENAME(N'ix_' + @table + N'_tenant') +
               N' ON ' + @qualified + N' (tenant_id) INCLUDE (code);';
    EXEC sys.sp_executesql @sql;

    IF @i % 3 = 0
    BEGIN
        SET @sql = N'CREATE NONCLUSTERED INDEX ' + QUOTENAME(N'ix_' + @table + N'_code') +
                   N' ON ' + @qualified + N' (code);';
        EXEC sys.sp_executesql @sql;
    END

    SET @i += 1;
END
GO

-- Rows, so the page counts that size buildings are not all zero. A few tables get
-- far more, so the skyline has real variation rather than one uniform height.
DECLARE @tableCount int = $(TableCount);
DECLARE @schemaCount int = $(SchemaCount);
DECLARE @i int = 1;
DECLARE @schema sysname;
DECLARE @qualified nvarchar(300);
DECLARE @rows int;
DECLARE @sql nvarchar(max);

WHILE @i <= @tableCount
BEGIN
    SET @schema = CONCAT('app', ((@i - 1) % @schemaCount) + 1);
    SET @qualified = QUOTENAME(@schema) + N'.' + QUOTENAME(CONCAT('entity_', @i));
    SET @rows = CASE WHEN @i % 97 = 0 THEN 5000
                     WHEN @i % 13 = 0 THEN 500
                     ELSE 25 END;

    SET @sql = N'
INSERT INTO ' + @qualified + N' (tenant_id, code, label, amount)
SELECT TOP (' + CAST(@rows AS nvarchar(10)) + N')
    ABS(CHECKSUM(NEWID())) % 50,
    CONCAT(''C'', ABS(CHECKSUM(NEWID())) % 100000),
    REPLICATE(N''x'', 32),
    ABS(CHECKSUM(NEWID())) % 100000 / 100.0
FROM sys.all_columns AS a CROSS JOIN sys.all_columns AS b;';
    EXEC sys.sp_executesql @sql;

    SET @i += 1;
END
GO

SELECT
    object_count = COUNT(*),
    schema_count = COUNT(DISTINCT schema_id)
FROM sys.tables;
GO
