using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain.DatabaseCity;

/// <summary>Proves legacy city namespaces from captured identities, never names or ID suffixes.</summary>
public sealed class DatabaseCityNamespaceResolver
{
    private readonly HashSet<string> _catalogCities;
    private readonly Dictionary<string, HashSet<string>> _familyNamespaces;
    private readonly HashSet<string> _capturedNamespaces;
    private readonly Dictionary<string, HashSet<string>> _ownerNamespaces = new(StringComparer.Ordinal);
    private readonly HashSet<string> _legacyOwners = new(StringComparer.Ordinal);
    private readonly HashSet<string> _unprovenOwners = new(StringComparer.Ordinal);

    public DatabaseCityNamespaceResolver(
        IEnumerable<QueryFamilySummaryV1> families,
        IEnumerable<string> catalogCityIds)
        : this(families.Select(family => (family.FamilyId, family.DatabaseId)), catalogCityIds)
    {
    }

    public DatabaseCityNamespaceResolver(
        IEnumerable<(string FamilyId, string DatabaseId)> families,
        IEnumerable<string> catalogCityIds)
    {
        _catalogCities = catalogCityIds.GroupBy(id => id, StringComparer.Ordinal)
            .Where(group => group.Count() == 1).Select(group => group.Key).ToHashSet(StringComparer.Ordinal);
        _familyNamespaces = families.GroupBy(family => family.FamilyId, StringComparer.Ordinal)
            .ToDictionary(group => group.Key,
                group => group.Select(family => family.DatabaseId).ToHashSet(StringComparer.Ordinal),
                StringComparer.Ordinal);
        _capturedNamespaces = _familyNamespaces.Values.SelectMany(values => values)
            .Where(value => !string.IsNullOrWhiteSpace(value)).ToHashSet(StringComparer.Ordinal);
    }

    public void Observe(DatabaseCityPageV1 page)
    {
        if (!_ownerNamespaces.TryGetValue(page.DatabaseId, out var candidates))
        {
            candidates = new HashSet<string>(StringComparer.Ordinal);
            _ownerNamespaces.Add(page.DatabaseId, candidates);
        }
        if (!page.HasQueryStoreDatabaseId)
            _legacyOwners.Add(page.DatabaseId);
        else if (string.IsNullOrWhiteSpace(page.QueryStoreDatabaseId))
            _unprovenOwners.Add(page.DatabaseId);
        else
            candidates.Add(page.QueryStoreDatabaseId);

        if (_capturedNamespaces.Contains(page.DatabaseId))
            candidates.Add(page.DatabaseId);
        foreach (var family in page.TopQueryFamilies)
        {
            if (!_familyNamespaces.TryGetValue(family.FamilyId, out var namespaces))
                continue;
            if (namespaces.Count != 1 || namespaces.Any(string.IsNullOrWhiteSpace))
                _unprovenOwners.Add(page.DatabaseId);
            candidates.UnionWith(namespaces.Where(value => !string.IsNullOrWhiteSpace(value)));
        }
    }

    public IReadOnlyDictionary<string, string> GetMappings()
    {
        var ownersByNamespace = _ownerNamespaces
            .SelectMany(owner => owner.Value.Select(value => (Namespace: value, Owner: owner.Key)))
            .ToLookup(pair => pair.Namespace, pair => pair.Owner, StringComparer.Ordinal);
        var mappings = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var owner in _legacyOwners)
        {
            var candidates = _ownerNamespaces[owner];
            if (!_catalogCities.Contains(owner) || _unprovenOwners.Contains(owner) || candidates.Count != 1)
                continue;
            var candidate = candidates.Single();
            if (ownersByNamespace[candidate].Count() == 1)
                mappings.Add(owner, candidate);
        }
        return mappings;
    }
}
