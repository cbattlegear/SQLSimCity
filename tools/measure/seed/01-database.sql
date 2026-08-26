-- Creates the measurement database and configures Query Store to actually retain
-- what the seed workload produces.
--
-- Two defaults would otherwise quietly ruin a measurement run:
--
--   QUERY_CAPTURE_MODE = AUTO discards cheap ad-hoc queries, so a seeded workload
--   can run to completion and still leave whole families missing from the store.
--   ALL is the only setting that guarantees what was executed is what is measured.
--
--   INTERVAL_LENGTH_MINUTES = 60 produces one runtime-stats interval per hour, so a
--   short seed run yields a single interval and cannot exercise the paging behaviour
--   at all. 1 is the minimum and lets a few minutes of workload build real history.
--
--   STALE_QUERY_THRESHOLD_DAYS bounds how far back the store keeps anything. The
--   30-day default is ample for the fast path, whose history is minutes old, and
--   silently fatal for a deep-history run, which relabels intervals as months old
--   and would watch cleanup delete them. Add-DeepHistory.ps1 raises it via this
--   variable before it stretches anything.

SET NOCOUNT ON;
GO

IF DB_ID('$(DatabaseName)') IS NOT NULL
BEGIN
    ALTER DATABASE [$(DatabaseName)] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE [$(DatabaseName)];
END
GO

CREATE DATABASE [$(DatabaseName)];
GO

-- Simple recovery keeps the log from dominating the seed; this database exists only
-- to be measured against.
ALTER DATABASE [$(DatabaseName)] SET RECOVERY SIMPLE;
GO

ALTER DATABASE [$(DatabaseName)] SET QUERY_STORE = ON;
GO

ALTER DATABASE [$(DatabaseName)] SET QUERY_STORE (
    OPERATION_MODE = READ_WRITE,
    QUERY_CAPTURE_MODE = ALL,
    INTERVAL_LENGTH_MINUTES = 1,
    MAX_STORAGE_SIZE_MB = $(QueryStoreMaxSizeMb),
    SIZE_BASED_CLEANUP_MODE = AUTO,
    CLEANUP_POLICY = (STALE_QUERY_THRESHOLD_DAYS = $(StaleQueryThresholdDays)),
    MAX_PLANS_PER_QUERY = 200,
    DATA_FLUSH_INTERVAL_SECONDS = 60
);
GO

-- The reader account SQLSimCity is meant to run as, so the rig measures the
-- permissions an operator would actually grant rather than sa's.
IF SUSER_ID('sqlsimcity_reader') IS NULL
BEGIN
    CREATE LOGIN [sqlsimcity_reader] WITH PASSWORD = '$(ReaderPassword)',
        CHECK_POLICY = OFF;
END
GO

GRANT VIEW SERVER STATE TO [sqlsimcity_reader];
GRANT VIEW ANY DEFINITION TO [sqlsimcity_reader];
GRANT VIEW ANY DATABASE TO [sqlsimcity_reader];
GO

USE [$(DatabaseName)];
GO

IF DATABASE_PRINCIPAL_ID('sqlsimcity_reader') IS NULL
    CREATE USER [sqlsimcity_reader] FOR LOGIN [sqlsimcity_reader];
GO

ALTER ROLE [db_datareader] ADD MEMBER [sqlsimcity_reader];
GRANT VIEW DATABASE STATE TO [sqlsimcity_reader];
GO

SELECT
    actual_state_desc,
    query_capture_mode_desc,
    interval_length_minutes,
    max_storage_size_mb,
    stale_query_threshold_days
FROM sys.database_query_store_options;
GO
