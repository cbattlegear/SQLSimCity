-- Probe: city.statistics_age_page
-- Purpose: per-object statistics freshness for the same keyset-bounded parent object page used by
--   city.object_inventory_page.
-- Connection scope: database.
-- Minimum platform: SQL Server 2016 (13.x).
-- Azure SQL Database: supported and current-database scoped.
-- Permission: sys.dm_db_stats_properties requires SELECT on the statistics object; it returns no
--   row rather than raising when that is missing, which is why unreadable statistics are counted
--   separately below instead of being folded into the never-updated count.
-- Result contract: one row per object that carries at least one non-hypothetical statistic, for at
--   most @TopN parent tables/indexed views. oldest_last_updated is the freshness of the *stalest*
--   statistic on the object, so an object is only as fresh as its worst statistic. It ignores
--   statistics that have never been updated, because MIN skips NULL, so never_updated_count carries
--   those separately -- a never-updated statistic is not the same measurement as an old one, and
--   collapsing them would report "fresh" for an object whose statistics have never been built.
-- Relative cost: low; keyset bounded by @TopN.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

WITH selected_objects AS
(
    SELECT TOP (@TopN)
        o.object_id
    FROM sys.objects AS o
    WHERE o.object_id > @AfterObjectId
      AND o.is_ms_shipped = 0
      AND
      (
          o.type = 'U'
          OR
          (
              o.type = 'V'
              AND EXISTS
              (
                  SELECT 1
                  FROM sys.indexes AS indexed_view_index
                  WHERE indexed_view_index.object_id = o.object_id
                    AND indexed_view_index.index_id > 0
              )
          )
      )
    ORDER BY o.object_id
)
SELECT
    selected.object_id,
    COUNT(*) AS statistics_count,
    MIN(properties.last_updated) AS oldest_last_updated,
    SUM(CASE WHEN properties.rows IS NOT NULL AND properties.last_updated IS NULL THEN 1 ELSE 0 END)
        AS never_updated_count,
    -- The applied function yielding no row at all means the statistic could not be read, which is
    -- not evidence that it is stale. Reporting it separately keeps "not observed" out of "none".
    SUM(CASE WHEN properties.rows IS NULL THEN 1 ELSE 0 END) AS unreadable_count,
    MAX(properties.modification_counter) AS max_modification_counter
FROM selected_objects AS selected
JOIN sys.stats AS stat
  ON stat.object_id = selected.object_id
OUTER APPLY sys.dm_db_stats_properties(stat.object_id, stat.stats_id) AS properties
WHERE stat.is_hypothetical = 0
GROUP BY selected.object_id
ORDER BY selected.object_id;
