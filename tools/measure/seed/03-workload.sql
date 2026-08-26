-- Installs the workload generator.
--
-- Families are made structurally distinct (different tables, different shapes)
-- rather than by varying literals, because that is what produces separate
-- entries in sys.query_store_query rather than one family with many parameter
-- values. The runner calls this repeatedly across several runtime-stats
-- intervals so the history has depth as well as breadth -- paging over
-- sys.query_store_runtime_stats is exercised by interval count multiplied by
-- plan count, and a single interval cannot exercise it at all.

SET NOCOUNT ON;
GO

USE [$(DatabaseName)];
GO

CREATE OR ALTER PROCEDURE dbo.RunWorkload
    @FamilyCount int = 400,
    @SchemaCount int = 8
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @i int = 1;
    DECLARE @sql nvarchar(max);
    DECLARE @rowcount int;

    WHILE @i <= @FamilyCount
    BEGIN
        DECLARE @schema sysname = CONCAT('app', ((@i - 1) % @SchemaCount) + 1);
        DECLARE @table sysname = CONCAT('entity_', @i);
        DECLARE @qualified nvarchar(300) = QUOTENAME(@schema) + '.' + QUOTENAME(@table);

        -- Shape 1: seek on the covering nonclustered index.
        SET @sql = N'SELECT TOP (10) id, code FROM ' + @qualified +
                   N' WHERE tenant_id = @tenant ORDER BY id DESC;';
        EXEC sys.sp_executesql @sql, N'@tenant int', @tenant = 7;

        -- Shape 2: aggregate, which reads more of the object.
        SET @sql = N'SELECT tenant_id, SUM(amount) AS total, COUNT_BIG(*) AS rows_seen FROM ' +
                   @qualified + N' GROUP BY tenant_id;';
        EXEC sys.sp_executesql @sql;

        -- Shape 3: a residual predicate that cannot use the index, so this family
        -- is genuinely more expensive than the other two and the metric ordering
        -- the city sorts by has something real to sort.
        SET @sql = N'SELECT COUNT_BIG(*) FROM ' + @qualified +
                   N' WHERE label LIKE @pattern;';
        EXEC sys.sp_executesql @sql, N'@pattern nvarchar(64)', @pattern = N'%x%';

        -- Shape 4: a two-object join, so plan-to-object attribution has a
        -- multi-object plan to apportion rather than only single-table plans.
        IF @i > 1
        BEGIN
            DECLARE @otherSchema sysname = CONCAT('app', ((@i - 2) % @SchemaCount) + 1);
            DECLARE @other nvarchar(300) =
                QUOTENAME(@otherSchema) + '.' + QUOTENAME(CONCAT('entity_', @i - 1));
            SET @sql = N'SELECT TOP (25) l.id, r.code FROM ' + @qualified + N' AS l
    JOIN ' + @other + N' AS r ON r.tenant_id = l.tenant_id
    WHERE l.amount > @floor;';
            EXEC sys.sp_executesql @sql, N'@floor decimal(18,4)', @floor = 10.0;
        END

        SET @i += 1;
    END
END
GO

PRINT 'dbo.RunWorkload installed.';
GO
