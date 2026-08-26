-- Waits for Query Store to be writable, or fails saying so.
--
-- Query Store parks itself in READ_ONLY when its in-memory backlog reaches an internal
-- limit rather than failing anything -- observed on this rig with readonly_reason 262144,
-- "the size of in-memory items waiting to be persisted has reached the internal memory
-- limit", both on a freshly created database and again after the eight history passes.
-- It clears itself once the backlog drains.
--
-- It is worth waiting for rather than working around, because of how it fails. A workload
-- pass through a READ_ONLY store runs to completion and captures nothing, and
-- sp_query_store_flush_db has nothing it can do, so a seed built through one finishes
-- looking healthy with an empty store behind it.
--
-- Not part of the numbered seed sequence: this runs wherever a caller is about to depend
-- on the store accepting writes.

SET NOCOUNT ON;
GO

DECLARE @deadline datetime2(0) = DATEADD(second, $(TimeoutSeconds), SYSDATETIME());
DECLARE @state nvarchar(60), @reason bigint, @announced bit = 0;

WHILE 1 = 1
BEGIN
    SELECT @state = actual_state_desc, @reason = readonly_reason
    FROM sys.database_query_store_options;

    IF @state IS NULL
        THROW 51000, 'Query Store is not enabled on this database.', 1;

    IF @state = 'READ_WRITE'
    BEGIN
        IF @announced = 1 PRINT '  Query Store is READ_WRITE again.';
        BREAK;
    END

    IF SYSDATETIME() >= @deadline
    BEGIN
        DECLARE @message nvarchar(400) = CONCAT(
            'Query Store is still ', @state, ' (readonly_reason ', @reason,
            ') after $(TimeoutSeconds)s. Workload passes through it capture nothing.');
        THROW 51000, @message, 1;
    END

    IF @announced = 0
    BEGIN
        PRINT CONCAT('  Query Store is not writable yet (', @state, ', readonly_reason ', @reason, '); waiting...');
        SET @announced = 1;
    END

    WAITFOR DELAY '00:00:05';
END
GO
