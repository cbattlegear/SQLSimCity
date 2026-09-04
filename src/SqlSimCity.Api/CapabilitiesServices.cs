using SqlSimCity.Collection.Catalog;
using SqlSimCity.Collection.Negotiation;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Domain;
using SqlSimCity.SqlServer;

namespace SqlSimCity.Api;

internal static class CapabilitiesServices
{
    public static async Task AddLocalCapabilitiesAsync(
        this IServiceCollection services,
        IConfiguration configuration,
        ProbeCatalog catalog)
    {
        var atlasConnected = AtlasConfiguration.IsConnected(configuration);
        if (!atlasConnected && !LiveIncidentsServiceCollectionExtensions.IsConnected(configuration))
        {
            services.AddSingleton<ICapabilitiesSource>(await FixtureCapabilitiesSource.CreateAsync()
                .ConfigureAwait(false));
            return;
        }

        services.AddSingleton<IProbeExecutor>(provider =>
        {
            var target = provider.GetRequiredService<ConnectedCapabilityTarget>();
            var factory = atlasConnected
                ? provider.GetRequiredService<ISqlConnectionFactory>()
                : provider.GetRequiredKeyedService<ISqlConnectionFactory>(
                    LiveIncidentsServiceCollectionExtensions.ConnectionFactoryServiceKey);
            return new SqlClientProbeExecutor(factory, target.Profile, catalog, target.Platform);
        });
        services.AddSingleton<ICapabilityNegotiator, CapabilityNegotiator>();
        services.AddSingleton<ConnectedCapabilitiesSource>();
        services.AddSingleton<ICapabilitiesSource>(provider => provider.GetRequiredService<ConnectedCapabilitiesSource>());
        services.AddHostedService(provider => provider.GetRequiredService<ConnectedCapabilitiesSource>());
    }
}
