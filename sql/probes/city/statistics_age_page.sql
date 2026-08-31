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
--   past_auto_update_threshold_count is the count of statistics whose modification_counter has
--   passed the engine's own AUTO_UPDATE_STATISTICS recompilation threshold, which is the only
--   measured statement here about whether a statistic *should* be updated. Age is not: a statistic
--   built a year ago against a table nothing has modified since is still exactly right.
-- Threshold: the SQL Server 2016 (13.x) / compatibility level 130+ rule, evaluated per statistic
--   against that statistic's own cardinality at its last update --
--     n <= 500                -> 500 modifications
--     n >  500                -> MIN(500 + (0.20 * n), SQRT(1000 * n))
--   The lower temporary-table thresholds (n < 6 -> 6) are deliberately not applied: this probe is
--   database-scoped over is_ms_shipped = 0 user tables and indexed views, so a temporary table is
--   not in range. Databases below compatibility level 130 use the older flat 500 + (0.20 * n) rule
--   and are therefore reported as needing an update slightly later than the engine would act; the
--   compat level is not read here because the count is advisory, not a prediction of the engine.
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
    MAX(properties.modification_counter) AS max_modification_counter,
    -- An unreadable statistic contributes 0 here for the same reason it is excluded from the age:
    -- its threshold cannot be evaluated, and counting it would render missing evidence as a finding.
    SUM(CASE
            WHEN properties.rows IS NOT NULL
                 AND properties.modification_counter > auto_update.recompilation_threshold
            THEN 1
            ELSE 0
        END) AS past_auto_update_threshold_count
FROM selected_objects AS selected
JOIN sys.stats AS stat
  ON stat.object_id = selected.object_id
OUTER APPLY sys.dm_db_stats_properties(stat.object_id, stat.stats_id) AS properties
CROSS APPLY
(
    -- Computed in float so that SQRT and the 0.20 factor do not truncate; the comparison above is
    -- against a bigint modification_counter, so only the boundary case is affected and rounding it
    -- down would report a statistic as past a threshold the engine has not reached.
    SELECT CASE
               WHEN properties.rows IS NULL THEN NULL
               WHEN properties.rows <= 500 THEN 500.0E0
               WHEN 500.0E0 + (0.20E0 * properties.rows) < SQRT(1000.0E0 * properties.rows)
                   THEN 500.0E0 + (0.20E0 * properties.rows)
               ELSE SQRT(1000.0E0 * properties.rows)
           END AS recompilation_threshold
) AS auto_update
-- Hypothetical statistics come from the hypothetical indexes the Database Engine Tuning Advisor
-- leaves behind, and describe an index that does not exist. `is_hypothetical` is a column of
-- sys.indexes, not sys.stats -- reading it off sys.stats fails the whole batch with "Invalid column
-- name", which is how this probe came to return nothing at all against a real instance. A statistic
-- built for an index shares its id, so the index is what has to be checked.
WHERE NOT EXISTS
      (
          SELECT 1
          FROM sys.indexes AS hypothetical_index
          WHERE hypothetical_index.object_id = stat.object_id
            AND hypothetical_index.index_id = stat.stats_id
            AND hypothetical_index.is_hypothetical = 1
      )
GROUP BY selected.object_id
ORDER BY selected.object_id;
