using System.Security.Cryptography;
using System.Text;
using Microsoft.SqlServer.TransactSql.ScriptDom;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.QueryStore;

public static class SqlTextNormalizer
{
    private const int MaximumSqlCharacters = 256 * 1024;

    public static QueryTextDescriptorV1 Normalize(
        string? rawText,
        bool isEncrypted,
        bool isRestricted,
        bool? initialQuotedIdentifiers = true)
    {
        if (isEncrypted)
            return Missing(QueryTextAvailability.Encrypted, "Query text belongs to an encrypted module.");
        if (isRestricted)
            return Missing(QueryTextAvailability.Restricted, "Query Store marks this query text as restricted.");
        if (string.IsNullOrWhiteSpace(rawText))
            return Missing(QueryTextAvailability.Missing, "Query Store returned no query text.");
        if (rawText.Length > MaximumSqlCharacters)
            return Missing(QueryTextAvailability.Missing, "Query text exceeds the safe normalization limit.");
        if (initialQuotedIdentifiers is null && rawText.Contains('"'))
            return Missing(QueryTextAvailability.Missing,
                "Query text contains double quotes but its QUOTED_IDENTIFIER context is unavailable.");

        var quotedIdentifiers = initialQuotedIdentifiers ?? true;
        var parser = new TSql170Parser(quotedIdentifiers);
        using var reader = new StringReader(rawText);
        var fragment = parser.Parse(reader, out var errors);

        var tokens = errors.Count == 0 ? fragment.ScriptTokenStream : null;
        var reason = "Literals were replaced by the SQL Server 2025 ScriptDom parser; raw SQL remains encrypted.";
        if (tokens is null)
        {
            tokens = ParameterizedBatchTokens(rawText, quotedIdentifiers);
            if (tokens is null)
                return Missing(QueryTextAvailability.Missing, "SQL text could not be safely normalized by ScriptDom.");
            reason = "Query Store recorded this statement with its sp_executesql parameter declaration, which is not a " +
                "standalone batch; the declaration was verified to hold only parameter names and types before the " +
                "statement after it was parsed. Literals were replaced by the SQL Server 2025 ScriptDom parser; raw " +
                "SQL remains encrypted.";
        }

        var normalized = new StringBuilder(rawText.Length);
        foreach (var token in tokens)
        {
            if (token.TokenType is TSqlTokenType.WhiteSpace or TSqlTokenType.MultilineComment or
                TSqlTokenType.SingleLineComment or TSqlTokenType.EndOfFile) continue;
            if (normalized.Length > 0) normalized.Append(' ');
            normalized.Append(SafeToken(token, quotedIdentifiers));
        }

        var value = normalized.ToString();
        return new QueryTextDescriptorV1(
            QueryTextAvailability.Available, value, Fingerprint(value), reason);
    }

    /// <summary>
    /// Query Store records a parameterized statement as its sp_executesql parameter declaration followed by the
    /// statement itself — <c>(@P0 int)SELECT ...</c> — which no T-SQL parser accepts as a batch. Recovers the token
    /// stream for that shape, and only that shape: the declaration must lex cleanly and contain nothing but parameter
    /// names and type names, and the statement after it must parse on its own. Returns null otherwise, so anything
    /// this does not positively recognise still fails closed.
    /// </summary>
    private static IList<TSqlParserToken>? ParameterizedBatchTokens(string rawText, bool quotedIdentifiers)
    {
        var lexer = new TSql170Parser(quotedIdentifiers);
        using var reader = new StringReader(rawText);
        var tokens = lexer.GetTokenStream(reader, out var lexErrors);
        if (lexErrors.Count != 0 || tokens is null || tokens.Count == 0) return null;

        var index = SkipTrivia(tokens, 0);
        if (index >= tokens.Count || tokens[index].TokenType != TSqlTokenType.LeftParenthesis) return null;

        var afterOpen = SkipTrivia(tokens, index + 1);
        if (afterOpen >= tokens.Count || tokens[afterOpen].TokenType != TSqlTokenType.Variable) return null;

        var depth = 0;
        var close = -1;
        for (var i = index; i < tokens.Count; i++)
        {
            var type = tokens[i].TokenType;
            if (type is TSqlTokenType.LeftParenthesis) { depth++; continue; }
            if (type is TSqlTokenType.RightParenthesis)
            {
                depth--;
                if (depth == 0) { close = i; break; }
                continue;
            }

            if (!IsParameterDeclarationToken(type)) return null;
        }

        if (close < 0) return null;

        var bodyStart = tokens[close].Offset + tokens[close].Text.Length;
        if (bodyStart >= rawText.Length) return null;
        var body = rawText[bodyStart..];
        if (string.IsNullOrWhiteSpace(body)) return null;

        var bodyParser = new TSql170Parser(quotedIdentifiers);
        using var bodyReader = new StringReader(body);
        var bodyFragment = bodyParser.Parse(bodyReader, out var bodyErrors);
        if (bodyErrors.Count != 0 || bodyFragment.ScriptTokenStream is null) return null;

        return tokens;
    }

    private static int SkipTrivia(IList<TSqlParserToken> tokens, int index)
    {
        while (index < tokens.Count && tokens[index].TokenType is TSqlTokenType.WhiteSpace or
               TSqlTokenType.MultilineComment or TSqlTokenType.SingleLineComment) index++;
        return index;
    }

    /// <summary>
    /// The allowlist a parameter declaration is held to. It admits no literal kind other than the integer lengths in
    /// <c>decimal(18,2)</c>, so a misread prefix cannot carry a string, unicode or binary literal past this point.
    /// </summary>
    private static bool IsParameterDeclarationToken(TSqlTokenType type) =>
        type is TSqlTokenType.Variable or TSqlTokenType.Identifier or TSqlTokenType.QuotedIdentifier or
            TSqlTokenType.Dot or TSqlTokenType.Comma or TSqlTokenType.Integer or TSqlTokenType.As or
            TSqlTokenType.WhiteSpace or TSqlTokenType.MultilineComment or TSqlTokenType.SingleLineComment;

    private static string SafeToken(TSqlParserToken token, bool quotedIdentifiers)
    {
        if (token.Text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return "0x00";
        if (!quotedIdentifiers && token.Text.Length >= 2 &&
            token.Text[0] == '"' && token.Text[^1] == '"') return "\"?\"";
        return token.TokenType switch
        {
        TSqlTokenType.AsciiStringLiteral => "'?'",
        TSqlTokenType.UnicodeStringLiteral => "N'?'",
        TSqlTokenType.Integer or TSqlTokenType.Numeric or TSqlTokenType.Real or TSqlTokenType.Money => "0",
        _ => token.Text,
        };
    }

    private static QueryTextDescriptorV1 Missing(QueryTextAvailability availability, string reason) =>
        new(availability, null, null, reason);

    private static string Fingerprint(string normalized) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized))).ToLowerInvariant();
}
