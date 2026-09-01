using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.QueryStore;

public sealed class SqlTextNormalizerTests
{
    [Fact]
    public void ReplacesEveryLiteralAndDropsComments()
    {
        const string secret = "private-customer";
        var result = SqlTextNormalizer.Normalize(
            $"SELECT * FROM dbo.T WHERE name = N'{secret}' AND id = 42 AND token = 0xDEADBEEF -- {secret}",
            false, false);

        Assert.Equal(QueryTextAvailability.Available, result.Availability);
        Assert.DoesNotContain(secret, result.NormalizedText, StringComparison.Ordinal);
        Assert.DoesNotContain("DEADBEEF", result.NormalizedText, StringComparison.Ordinal);
        Assert.Contains("N'?'", result.NormalizedText, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("SELECT 'unterminated", false, false, QueryTextAvailability.Missing)]
    [InlineData("SELECT 1", true, false, QueryTextAvailability.Encrypted)]
    [InlineData("SELECT 1", false, true, QueryTextAvailability.Restricted)]
    public void FailsClosed(
        string sql, bool encrypted, bool restricted, QueryTextAvailability expected)
    {
        var result = SqlTextNormalizer.Normalize(sql, encrypted, restricted);
        Assert.Equal(expected, result.Availability);
        Assert.Null(result.NormalizedText);
        Assert.Null(result.NormalizedTextFingerprint);
    }

    [Fact]
    public void RespectsQuotedIdentifierOffAndFailsClosedWithoutContext()
    {
        var normalized = SqlTextNormalizer.Normalize(
            "SELECT \"private literal\"", false, false, initialQuotedIdentifiers: false);
        var unknown = SqlTextNormalizer.Normalize(
            "SELECT \"private literal\"", false, false, initialQuotedIdentifiers: null);

        Assert.Equal(QueryTextAvailability.Available, normalized.Availability);
        Assert.DoesNotContain("private literal", normalized.NormalizedText, StringComparison.Ordinal);
        Assert.Equal(QueryTextAvailability.Missing, unknown.Availability);
    }

    [Theory]
    [InlineData("(@P0 int)SELECT id FROM dbo.t WHERE id = @P0")]
    [InlineData("(@p0 nvarchar(4000),@p1 bigint)SELECT * FROM dbo.t WHERE name = @p0 AND id = @p1")]
    [InlineData("(@1 tinyint)SELECT * FROM [t] WHERE [id]=@1")]
    [InlineData("(@P0 decimal(18,2), @P1 dbo.MyType READONLY)INSERT INTO dbo.t(a) VALUES(@P0)")]
    [InlineData("(@P0 nvarchar(max))EXEC dbo.p @P0")]
    public void NormalizesQueryStoreParameterDeclarationPrefix(string sql)
    {
        var result = SqlTextNormalizer.Normalize(sql, false, false);

        Assert.Equal(QueryTextAvailability.Available, result.Availability);
        Assert.NotNull(result.NormalizedTextFingerprint);
        Assert.StartsWith("( @", result.NormalizedText, StringComparison.Ordinal);
    }

    [Fact]
    public void ParameterDeclarationPrefixStillReplacesLiterals()
    {
        const string secret = "private-customer";
        var result = SqlTextNormalizer.Normalize(
            $"(@p0 nvarchar(4000))SELECT * FROM dbo.T WHERE name = N'{secret}' AND token = 0xDEADBEEF", false, false);

        Assert.Equal(QueryTextAvailability.Available, result.Availability);
        Assert.DoesNotContain(secret, result.NormalizedText, StringComparison.Ordinal);
        Assert.DoesNotContain("DEADBEEF", result.NormalizedText, StringComparison.Ordinal);
        Assert.Contains("@p0 nvarchar ( 0 )", result.NormalizedText, StringComparison.Ordinal);
    }

    [Fact]
    public void ParameterDeclarationPrefixKeepsDistinctFingerprintsPerParameterList()
    {
        var first = SqlTextNormalizer.Normalize("(@p0 int)SELECT a FROM dbo.t WHERE a = @p0", false, false);
        var second = SqlTextNormalizer.Normalize("(@p0 bigint)SELECT a FROM dbo.t WHERE a = @p0", false, false);

        Assert.NotEqual(first.NormalizedTextFingerprint, second.NormalizedTextFingerprint);
    }

    [Theory]
    // A leading parenthesis that is not a parameter declaration must not open the recovery path.
    [InlineData("(SELECT 'secret'")]
    [InlineData("(@p0 int)SELECT 'unterminated")]
    [InlineData("(@p0 int, N'secret')SELECT 1")]
    [InlineData("(@p0 int)")]
    [InlineData("(@p0 int")]
    public void FailsClosedOnAnythingButAParameterDeclarationPrefix(string sql)
    {
        var result = SqlTextNormalizer.Normalize(sql, false, false);

        Assert.Equal(QueryTextAvailability.Missing, result.Availability);
        Assert.Null(result.NormalizedText);
        Assert.Null(result.NormalizedTextFingerprint);
    }
}
