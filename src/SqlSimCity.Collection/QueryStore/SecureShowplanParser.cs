using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.QueryStore;

/// <param name="MaximumNodes">
/// Cap on <c>RelOp</c> operators, which are the only elements retained as plan nodes. A real
/// Showplan carries thousands of non-operator elements (<c>ColumnReference</c>,
/// <c>ScalarOperator</c>, <c>DefinedValue</c>) for every operator, so counting all elements
/// against this cap rejected ordinary plans.
/// </param>
/// <param name="MaximumElements">
/// Cap on total XML elements streamed. This is the pathological-expansion guard for work that is
/// not retained; everything this parser keeps is bounded by <paramref name="MaximumNodes"/>,
/// <paramref name="MaximumNodeExpressions"/>, and <paramref name="MaximumNodeWarnings"/>.
/// </param>
/// <param name="MaximumNodeExpressions">
/// Cap on expressions retained for a single operator. Expressions are the one unbounded list an
/// operator accumulates, and <c>Build</c> sorts and joins all of them, so they need a stated bound
/// rather than one inherited from the element counter.
/// </param>
/// <param name="MaximumNodeWarnings">
/// Cap on warnings retained for a single operator. Every element under <c>Warnings</c> allocates a
/// warning and canonicalizes its attributes, so this bounds allocation and regex work alike.
/// </param>
/// <param name="MaximumMissingIndexes">
/// Cap on plan-level missing-index suggestions retained. These are not bounded by
/// <paramref name="MaximumNodes"/> because they hang off <c>QueryPlan</c> rather than off an
/// operator, so a plan with no operators at all could still carry a long list.
/// </param>
/// <param name="MaximumMissingIndexColumns">
/// Cap on columns retained across all three column groups of a single missing index.
/// </param>
public sealed record ShowplanParserLimits(
    int MaximumXmlCharacters = 8 * 1024 * 1024,
    int MaximumDepth = 128,
    int MaximumNodes = 20_000,
    int MaximumTextCharacters = 4 * 1024 * 1024,
    int MaximumElements = 400_000,
    int MaximumNodeExpressions = 4_000,
    int MaximumNodeWarnings = 1_000,
    int MaximumMissingIndexes = 1_000,
    int MaximumMissingIndexColumns = 1_000);

public sealed class SecureShowplanParser
{
    private const string Caveat =
        "Compiled plan structure with aggregate query-level Query Store runtime only; Query Store does not provide actual operator progress or actual operator metrics.";

    /*
     * Warnings the engine writes as attributes on `<Warnings>` rather than as child elements.
     *
     * There is no marker in the document that distinguishes these from the element-shaped warnings,
     * so they have to be named. The names are the attribute names from the Showplan schema, and they
     * are emitted as warning kinds so that one vocabulary covers both spellings -- otherwise
     * `NoJoinPredicate` is a kind no plan can ever carry.
     */
    private static readonly string[] WarningFlagAttributes =
        ["NoJoinPredicate", "SpatialGuess", "FullUpdateForOnlineIndexBuild"];

    private readonly ShowplanParserLimits _limits;

    public SecureShowplanParser(ShowplanParserLimits? limits = null) =>
        _limits = limits ?? new ShowplanParserLimits();

    public async Task<NormalizedShowplanV1> ParseAsync(
        string planId,
        string xml,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(planId);
        ArgumentNullException.ThrowIfNull(xml);
        if (xml.Length > _limits.MaximumXmlCharacters)
        {
            throw new XmlException($"Showplan exceeds the {_limits.MaximumXmlCharacters}-character limit.");
        }

        var settings = new XmlReaderSettings
        {
            Async = true,
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = _limits.MaximumXmlCharacters,
            MaxCharactersFromEntities = 0,
            IgnoreComments = true,
            IgnoreProcessingInstructions = true,
        };

        using var textReader = new StringReader(xml);
        using var reader = XmlReader.Create(textReader, settings);
        var builders = new List<NodeBuilder>();
        var nodeStack = new Stack<NodeBuilder>();
        var elementStack = new Stack<string>();
        var textCharacters = 0;
        var warningsDepth = 0;
        string version = "unknown";
        string? ceVersion = null;
        decimal? desiredMemory = null;
        decimal? requiredMemory = null;
        var optimization = QueryOptimizationKind.None;
        string? dispatcherExpression = null;
        var elementCount = 0;
        var operatorCount = 0;
        var missingIndexes = new List<ShowplanMissingIndexV1>();
        // The suggestion being filled in. `<MissingIndex>` carries the table and `<ColumnGroup>`
        // children carry the columns, so it cannot be built until its subtree closes.
        MissingIndexBuilder? missingIndex = null;
        decimal? missingIndexGroupImpact = null;
        string? columnGroupUsage = null;

        while (await reader.ReadAsync())
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (reader.Depth > _limits.MaximumDepth)
            {
                throw new XmlException($"Showplan exceeds the maximum depth of {_limits.MaximumDepth}.");
            }

            if (reader.NodeType == XmlNodeType.Element)
            {
                if (++elementCount > _limits.MaximumElements)
                {
                    throw new XmlException($"Showplan exceeds the {_limits.MaximumElements}-element limit.");
                }

                var local = reader.LocalName;
                elementStack.Push(local);
                if (local == "Warnings" && !reader.IsEmptyElement) warningsDepth++;
                /*
                 * Several warnings are attributes on `<Warnings>` rather than child elements:
                 * `NoJoinPredicate`, `SpatialGuess` and `FullUpdateForOnlineIndexBuild` are all
                 * written that way by the engine. Recording only child elements meant those kinds
                 * were never produced at all, so a vocabulary that names them -- the findings rule
                 * does -- could never match, and a plan with no join predicate reported nothing.
                 */
                if (local == "Warnings" && nodeStack.TryPeek(out var flagNode))
                {
                    foreach (var flag in WarningFlagAttributes)
                        if (IsTrue(Attribute(reader, flag)))
                            AddWarning(flagNode, flag, null);
                }

                if (local == "ShowPlanXML")
                {
                    version = Attribute(reader, "Version") ?? version;
                }
                else if (local == "StmtSimple")
                {
                    ceVersion = Attribute(reader, "CardinalityEstimationModelVersion") ?? ceVersion;
                }
                /*
                 * Missing indexes are plan-level and are handled before the warning branches below.
                 *
                 * `<MissingIndexes>` is a child of `<QueryPlan>` written *before* the first
                 * `<RelOp>`, so at this point no operator is open and nothing under it can be
                 * attributed to one. That is exactly why reading a missing index out of a node's
                 * warnings finds nothing: the block is over before the first operator begins.
                 */
                else if (local == "MissingIndexGroup")
                {
                    missingIndexGroupImpact = DecimalAttribute(reader, "Impact");
                }
                else if (local == "MissingIndex")
                {
                    missingIndex = new MissingIndexBuilder(
                        Attribute(reader, "Database"),
                        Attribute(reader, "Schema"),
                        Attribute(reader, "Table"),
                        missingIndexGroupImpact);
                    if (reader.IsEmptyElement) CompleteMissingIndex();
                }
                else if (local == "ColumnGroup" && missingIndex is not null)
                {
                    columnGroupUsage = Attribute(reader, "Usage");
                }
                else if (local == "Column" && missingIndex is not null && columnGroupUsage is not null)
                {
                    if (Attribute(reader, "Name") is { } columnName)
                        missingIndex.Add(columnGroupUsage, columnName, _limits.MaximumMissingIndexColumns);
                }
                else if (local == "MemoryGrantInfo")
                {
                    desiredMemory = DecimalAttribute(reader, "SerialDesiredMemory");
                    requiredMemory = DecimalAttribute(reader, "SerialRequiredMemory");
                }
                else if (local == "RelOp")
                {
                    if (++operatorCount > _limits.MaximumNodes)
                    {
                        throw new XmlException($"Showplan exceeds the {_limits.MaximumNodes}-operator limit.");
                    }

                    var builder = new NodeBuilder(
                        IntAttribute(reader, "NodeId") ?? throw new XmlException("RelOp is missing NodeId."),
                        nodeStack.TryPeek(out var parent) ? parent.NodeId : null,
                        Attribute(reader, "LogicalOp") ?? "Unknown",
                        Attribute(reader, "PhysicalOp") ?? "Unknown")
                    {
                        EstimatedRows = DecimalAttribute(reader, "EstimateRows"),
                        EstimatedRowSizeBytes = DecimalAttribute(reader, "AvgRowSize"),
                        EstimatedCpuCost = DecimalAttribute(reader, "EstimateCPU"),
                        EstimatedIoCost = DecimalAttribute(reader, "EstimateIO"),
                        EstimatedTotalSubtreeCost = DecimalAttribute(reader, "EstimatedTotalSubtreeCost"),
                        Parallel = string.Equals(Attribute(reader, "Parallel"), "true", StringComparison.OrdinalIgnoreCase),
                    };
                    builders.Add(builder);
                    nodeStack.Push(builder);
                }
                else if (local == "Object" && nodeStack.TryPeek(out var objectNode))
                {
                    objectNode.ObjectReference = new ShowplanObjectV1(
                        Attribute(reader, "Database"), Attribute(reader, "Schema"),
                        Attribute(reader, "Table"), Attribute(reader, "Index"));
                }
                else if (local == "ScalarOperator" && nodeStack.TryPeek(out var scalarNode) &&
                         Attribute(reader, "ScalarString") is { } scalar)
                {
                    AddExpression(scalarNode, SanitizeExpression(scalar));
                }
                else if (local != "Warnings" &&
                          local.Contains("Warning", StringComparison.OrdinalIgnoreCase) &&
                         nodeStack.TryPeek(out var warningNode))
                {
                    AddWarning(warningNode, local, CanonicalWarningAttributes(reader));
                }
                else if (warningsDepth > 0 && local != "Warnings" &&
                         nodeStack.TryPeek(out warningNode))
                {
                    AddWarning(warningNode, local, CanonicalWarningAttributes(reader));
                }
                else if (local is "ParameterSensitivePredicate" or "DispatcherExpression")
                {
                    optimization = QueryOptimizationKind.ParameterSensitivePlan;
                    dispatcherExpression = CanonicalAttributes(reader);
                }
                else if (local.Contains("OptionalParameter", StringComparison.OrdinalIgnoreCase))
                {
                    optimization = QueryOptimizationKind.OptionalParameterPlanOptimization;
                }

                if (reader.IsEmptyElement)
                {
                    elementStack.Pop();
                    if (local == "RelOp") nodeStack.Pop();
                }
            }
            else if (reader.NodeType is XmlNodeType.Text or XmlNodeType.CDATA)
            {
                // Only the running total is needed: no caller ever reads the concatenated text, so
                // accumulating it would be several megabytes of pure dead retention per parse.
                if (textCharacters + reader.Value.Length > _limits.MaximumTextCharacters)
                {
                    throw new XmlException($"Showplan text exceeds the {_limits.MaximumTextCharacters}-character limit.");
                }
                textCharacters += reader.Value.Length;
                if (elementStack.TryPeek(out var current) && current is "ScalarString" or "Predicate")
                {
                    if (nodeStack.TryPeek(out var predicateNode)) AddExpression(predicateNode, SanitizeExpression(reader.Value));
                }
                if (elementStack.TryPeek(out current) && current is "DispatcherExpression")
                {
                    dispatcherExpression = SanitizeExpression(reader.Value);
                }
            }
            else if (reader.NodeType == XmlNodeType.EndElement)
            {
                if (reader.LocalName == "RelOp" && nodeStack.Count > 0) nodeStack.Pop();
                if (reader.LocalName == "Warnings" && warningsDepth > 0) warningsDepth--;
                if (reader.LocalName == "MissingIndex") CompleteMissingIndex();
                if (reader.LocalName == "ColumnGroup") columnGroupUsage = null;
                if (reader.LocalName == "MissingIndexGroup") missingIndexGroupImpact = null;
                if (elementStack.Count > 0) elementStack.Pop();
            }
        }

        var nodes = builders.Select(builder => builder.Build()).ToArray();
        ValidateTree(nodes);
        var fingerprint = StructuralPlanFingerprint.Compute(
            nodes, optimization, dispatcherExpression, ceVersion, desiredMemory, requiredMemory);
        return new NormalizedShowplanV1(
            "1.0", planId, version, ceVersion, desiredMemory, requiredMemory, nodes,
            optimization, dispatcherExpression, fingerprint, Caveat,
            new QueryStoreEvidenceV1(QueryStoreSource.QueryStore, DataStatus.Available, null, null,
                "Normalized from a single on-demand Query Store Showplan document.", Caveat),
            // Always a list, never null: this parser looked. Null is reserved for plans normalized
            // by a build that had no missing-index reader at all.
            missingIndexes);

        // Both lists are retained for the lifetime of the parse and neither is bounded by the
        // element counter, so each states its own limit rather than inheriting one by side effect.
        void AddExpression(NodeBuilder node, string expression)
        {
            if (node.ExpressionCount >= _limits.MaximumNodeExpressions)
            {
                throw new XmlException(
                    $"A Showplan operator exceeds the {_limits.MaximumNodeExpressions}-expression limit.");
            }

            node.AddExpression(expression);
        }

        void AddWarning(NodeBuilder node, string name, string? detail)
        {
            if (node.Warnings.Count >= _limits.MaximumNodeWarnings)
            {
                throw new XmlException(
                    $"A Showplan operator exceeds the {_limits.MaximumNodeWarnings}-warning limit.");
            }

            node.Warnings.Add(new ShowplanWarningV1(name, detail));
        }

        void CompleteMissingIndex()
        {
            if (missingIndex is null) return;
            if (missingIndexes.Count >= _limits.MaximumMissingIndexes)
            {
                throw new XmlException(
                    $"A Showplan exceeds the {_limits.MaximumMissingIndexes}-missing-index limit.");
            }

            missingIndexes.Add(missingIndex.Build());
            missingIndex = null;
            columnGroupUsage = null;
        }
    }

    private static string? Attribute(XmlReader reader, string name) => reader.GetAttribute(name);

    /// <summary>
    /// Showplan writes its boolean attributes both ways -- <c>"true"</c> and <c>"1"</c> both appear
    /// for the same attribute across engine versions -- so both spellings are accepted. Anything
    /// else, including a missing attribute, is not a warning.
    /// </summary>
    private static bool IsTrue(string? value) =>
        string.Equals(value, "true", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(value, "1", StringComparison.Ordinal);
    private static int? IntAttribute(XmlReader reader, string name) =>
        int.TryParse(Attribute(reader, name), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) ? value : null;
    private static decimal? DecimalAttribute(XmlReader reader, string name) =>
        decimal.TryParse(Attribute(reader, name), NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : null;
    private static string SanitizeExpression(string value)
    {
        var sanitized = Regex.Replace(value, @"N?'(?:''|[^'])*'", "?", RegexOptions.CultureInvariant);
        sanitized = Regex.Replace(sanitized, @"\b0x[0-9A-Fa-f]+\b", "?", RegexOptions.CultureInvariant);
        return Regex.Replace(
            sanitized,
            @"(?<![\w@])(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?",
            "?",
            RegexOptions.CultureInvariant);
    }
    private static string? CanonicalAttributes(XmlReader reader)
    {
        if (!reader.HasAttributes) return null;
        var attributes = new List<string>();
        while (reader.MoveToNextAttribute())
            attributes.Add($"{reader.LocalName}={SanitizeExpression(reader.Value)}");
        reader.MoveToElement();
        attributes.Sort(StringComparer.Ordinal);
        return string.Join(';', attributes);
    }

    private static string? CanonicalWarningAttributes(XmlReader reader)
    {
        if (!reader.HasAttributes) return null;
        var attributes = new List<string>();
        while (reader.MoveToNextAttribute())
        {
            var value = decimal.TryParse(
                reader.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out _) ||
                bool.TryParse(reader.Value, out _)
                ? reader.Value
                : SanitizeExpression(reader.Value);
            attributes.Add($"{reader.LocalName}={value}");
        }
        reader.MoveToElement();
        attributes.Sort(StringComparer.Ordinal);
        return string.Join(';', attributes);
    }

    private void ValidateTree(ShowplanNodeV1[] nodes)
    {
        var ids = new HashSet<int>();
        foreach (var node in nodes)
            if (!ids.Add(node.NodeId)) throw new XmlException($"Showplan contains duplicate RelOp NodeId {node.NodeId}.");
        if (nodes.Length == 0) throw new XmlException("Showplan contains no RelOp tree.");
        var roots = nodes.Where(node => node.ParentNodeId is null).ToArray();
        if (roots.Length != 1) throw new XmlException("Showplan must contain exactly one RelOp root.");
        foreach (var node in nodes)
            if (node.ParentNodeId is { } parent && !ids.Contains(parent))
                throw new XmlException($"Showplan RelOp {node.NodeId} references missing parent {parent}.");

        var byId = nodes.ToDictionary(node => node.NodeId);
        foreach (var node in nodes)
        {
            var visited = new HashSet<int>();
            var current = node;
            var depth = 0;
            while (current.ParentNodeId is { } parent)
            {
                if (!visited.Add(current.NodeId)) throw new XmlException("Showplan RelOp tree contains a cycle.");
                if (++depth > _limits.MaximumDepth)
                    throw new XmlException($"Showplan RelOp tree exceeds the maximum depth of {_limits.MaximumDepth}.");
                current = byId[parent];
            }
        }
    }

    /// <summary>
    /// Accumulates one <c>&lt;MissingIndex&gt;</c> subtree. The table is on the element itself, the
    /// impact is on its <c>&lt;MissingIndexGroup&gt;</c> parent, and the columns arrive as
    /// <c>&lt;ColumnGroup&gt;</c> children, so the suggestion cannot be built until it closes.
    /// </summary>
    private sealed class MissingIndexBuilder(string? database, string? schema, string? table, decimal? impact)
    {
        private readonly List<string> _equality = [];
        private readonly List<string> _inequality = [];
        private readonly List<string> _included = [];

        private int Count => _equality.Count + _inequality.Count + _included.Count;

        public void Add(string usage, string column, int limit)
        {
            if (Count >= limit)
            {
                throw new XmlException(
                    $"A Showplan missing index exceeds the {limit}-column limit.");
            }

            // Usage is matched case-insensitively because it is a schema enumeration, not data, and
            // an unrecognised usage is dropped rather than filed under a group it does not belong to.
            if (string.Equals(usage, "EQUALITY", StringComparison.OrdinalIgnoreCase)) _equality.Add(column);
            else if (string.Equals(usage, "INEQUALITY", StringComparison.OrdinalIgnoreCase)) _inequality.Add(column);
            else if (string.Equals(usage, "INCLUDE", StringComparison.OrdinalIgnoreCase)) _included.Add(column);
        }

        public ShowplanMissingIndexV1 Build() =>
            new(database, schema, table, impact, [.. _equality], [.. _inequality], [.. _included]);
    }

    private sealed class NodeBuilder(int nodeId, int? parentNodeId, string logicalOperation, string physicalOperation)
    {
        public int NodeId { get; } = nodeId;
        public int? ParentNodeId { get; } = parentNodeId;
        public string LogicalOperation { get; } = logicalOperation;
        public string PhysicalOperation { get; } = physicalOperation;
        public decimal? EstimatedRows { get; init; }
        public decimal? EstimatedRowSizeBytes { get; init; }
        public decimal? EstimatedCpuCost { get; init; }
        public decimal? EstimatedIoCost { get; init; }
        public decimal? EstimatedTotalSubtreeCost { get; init; }
        public bool Parallel { get; init; }
        public ShowplanObjectV1? ObjectReference { get; set; }
        private List<string> Expressions { get; } = [];
        public List<ShowplanWarningV1> Warnings { get; } = [];

        public int ExpressionCount => Expressions.Count;

        public void AddExpression(string expression) => Expressions.Add(expression);

        public ShowplanNodeV1 Build() => new(
            NodeId, ParentNodeId, LogicalOperation, PhysicalOperation, EstimatedRows,
            EstimatedCpuCost, EstimatedIoCost, EstimatedTotalSubtreeCost, Parallel,
            ObjectReference,
            Expressions.Count == 0 ? null : string.Join(" && ", Expressions.Order(StringComparer.Ordinal)),
            Warnings,
            EstimatedRowSizeBytes);
    }
}

public static class StructuralPlanFingerprint
{
    public static string Compute(
        IEnumerable<ShowplanNodeV1> nodes,
        QueryOptimizationKind optimization,
        string? dispatcherExpression,
        string? cardinalityEstimatorVersion = null,
        decimal? serialDesiredMemoryKiB = null,
        decimal? serialRequiredMemoryKiB = null)
    {
        var canonical = PlanCanonicalizer.Canonicalize(
            nodes, optimization, dispatcherExpression, cardinalityEstimatorVersion,
            serialDesiredMemoryKiB, serialRequiredMemoryKiB);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString()))).ToLowerInvariant();
    }
}
