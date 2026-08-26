using Microsoft.Data.Sqlite;

namespace SqlSimCity.Storage.Sqlite;

/// <summary>
/// Turns an id prefix into a half-open primary-key range, so a prefix match can seek the
/// index instead of scanning the table. <c>substr(id, 1, n) = $prefix</c> applies a function
/// to the indexed column and is therefore not sargable.
///
/// The care is in the upper bound. SQLite's <c>BINARY</c> collation compares TEXT by
/// <c>memcmp</c> over the stored encoding, so the only correct exclusive bound is the
/// byte-successor of the prefix. <c>prefix + '\uFFFF'</c> is not that bound -- it excludes
/// ids that continue past U+FFFF -- and a <c>LIKE</c> rewrite changes matching again because
/// <c>%</c> and <c>_</c> are wildcards.
///
/// Rather than reason about byte successors for arbitrary Unicode, this accepts only
/// printable ASCII in a UTF-8 database, where every character occupies exactly one byte
/// below <c>0x7F</c> and the successor is the last character incremented. Every prefix this
/// store is actually given is generated ASCII (<c>qs:query-store-slot:0:</c> and
/// <c>qs:normalized-plan:&lt;64 hex&gt;:</c>). Anything else -- any non-ASCII character, or a
/// database whose <c>BINARY</c> collation is not comparing UTF-8 bytes -- gets no bound, and
/// the caller falls back to the exact <c>substr()</c> predicate, which is slow but selects
/// precisely the same rows.
/// </summary>
internal static class SqlitePrefixRange
{
    private const string RangeSql =
        "DELETE FROM protected_records WHERE id >= $prefix AND id < $upperBound;";

    private const string ExactSql =
        "DELETE FROM protected_records WHERE substr(id, 1, $length) = $prefix;";

    /// <summary>
    /// Points <paramref name="command"/> at the narrowest delete that still matches exactly
    /// the ids starting with <paramref name="idPrefix"/>, and reports whether that was the
    /// indexed range. This is the only place the predicate is chosen, so a test can assert
    /// on the same statement the store executes rather than on a restatement of it.
    /// </summary>
    public static bool ConfigureDelete(
        SqliteCommand command,
        string idPrefix,
        bool databaseEncodingIsUtf8)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (TryGetExclusiveUpperBound(idPrefix, databaseEncodingIsUtf8, out var upperBound))
        {
            command.CommandText = RangeSql;
            command.Parameters.AddWithValue("$prefix", idPrefix);
            command.Parameters.AddWithValue("$upperBound", upperBound);
            return true;
        }

        command.CommandText = ExactSql;
        command.Parameters.AddWithValue("$length", idPrefix.Length);
        command.Parameters.AddWithValue("$prefix", idPrefix);
        return false;
    }

    /// <summary>
    /// Produces the exclusive upper bound <c>U</c> for which <c>id &gt;= prefix AND id &lt; U</c>
    /// selects exactly the ids starting with <paramref name="prefix"/>, or returns
    /// <see langword="false"/> when no bound can be proven safe for this prefix.
    /// </summary>
    /// <param name="prefix">The literal id prefix to match.</param>
    /// <param name="databaseEncodingIsUtf8">
    /// Whether the target database stores TEXT as UTF-8, as reported by <c>PRAGMA encoding</c>.
    /// In a UTF-16 database <c>memcmp</c> also compares the high bytes of ASCII characters, so
    /// an id may sort inside the range without starting with the prefix.
    /// </param>
    /// <param name="upperBound">The exclusive upper bound, when one exists.</param>
    public static bool TryGetExclusiveUpperBound(
        string prefix,
        bool databaseEncodingIsUtf8,
        out string upperBound)
    {
        upperBound = string.Empty;
        if (!databaseEncodingIsUtf8 || string.IsNullOrEmpty(prefix)) return false;
        foreach (var character in prefix)
        {
            // Below ' ' includes NUL and the C0 controls; above '~' includes DEL and every
            // character that UTF-8 encodes as more than one byte.
            if (character is < ' ' or > '~') return false;
        }

        // Every character is at most '~' (0x7E), so the successor is at most 0x7F and still
        // encodes as the single byte the memcmp ordering needs.
        upperBound = string.Concat(prefix.AsSpan(0, prefix.Length - 1), [(char)(prefix[^1] + 1)]);
        return true;
    }
}
