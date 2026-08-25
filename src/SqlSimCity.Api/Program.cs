using System.Text.Json.Serialization;
using System.Xml;
using Microsoft.AspNetCore.SignalR;
using SqlSimCity.Api;
using SqlSimCity.Collection.Atlas;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Domain;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Secrets;
using SqlSimCity.Storage;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    WebRootPath = WebRootResolver.Resolve(AppContext.BaseDirectory),
});

var probeCatalog = ApplicationInitialization.LoadProbeCatalog();
var acquisitionMode = ArchiveServices.GetAcquisitionMode(builder.Configuration);
var archiveMode = acquisitionMode == AcquisitionMode.Archive;
var edgeMode = acquisitionMode == AcquisitionMode.Edge;

builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSignalR().AddJsonProtocol(options =>
    options.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSingleton(probeCatalog);

// Connected Query Store history retains query text and plan XML, so it needs a
// storage directory. An operator whose whole configuration is a connection string
// would otherwise get empty query views with no explanation. Enable it for them --
// but never in archive or edge mode, which forbid connected collection outright.
var protectedStorageProvisioning = archiveMode || edgeMode
    ? null
    : ProtectedStorageAutoProvisioning.TryProvision(builder.Configuration);
if (protectedStorageProvisioning is not null)
{
    builder.Configuration.AddInMemoryCollection(protectedStorageProvisioning.ConfigurationOverrides);
}

builder.Services.AddProtectedStorage(builder.Configuration);
var queryStoreConnected = QueryStoreHistoryConfiguration.IsConnected(builder.Configuration);
var atlasConnected = AtlasConfiguration.IsConnected(builder.Configuration);
var liveConnected = LiveIncidentsServiceCollectionExtensions.IsConnected(builder.Configuration);
var edgeIngestionEnabled = builder.Configuration.GetValue<bool>("EdgeIngestion:Enabled");
var protectedStorageEnabled = builder.Configuration.GetValue<bool>("ProtectedStorage:Enabled");
if (archiveMode && (
        queryStoreConnected ||
        atlasConnected ||
        liveConnected ||
        edgeIngestionEnabled ||
        protectedStorageEnabled))
    throw new InvalidOperationException(
        "Acquisition:Mode=Archive cannot be combined with connected Atlas, Query Store, live incidents, edge ingestion, or protected storage.");
if (edgeMode && (!edgeIngestionEnabled || queryStoreConnected || atlasConnected || liveConnected || protectedStorageEnabled))
    throw new InvalidOperationException(
        "Acquisition:Mode=Edge requires edge ingestion and cannot be combined with connected Atlas, Query Store, live incidents, or protected storage.");
if (!edgeMode && edgeIngestionEnabled)
    throw new InvalidOperationException("Edge ingestion may be enabled only when Acquisition:Mode=Edge.");
if (queryStoreConnected && !atlasConnected)
    throw new InvalidOperationException("Connected Query Store history requires Atlas:Mode=Connected so both share one validated profile and authentication strategy.");
if (queryStoreConnected && !builder.Configuration.GetValue<bool>("ProtectedStorage:Enabled"))
    throw new InvalidOperationException(
        "Connected Query Store history retains query text and plan XML, so it requires " +
        "ProtectedStorage:Enabled=true. Set it along with ProtectedStorage:DataDirectory (see " +
        "SECURITY.md for what lands there), or drive the connection from a connection string, " +
        "which enables it automatically.");

builder.Services.AddSqlSimCityReverseProxy(builder.Configuration);
builder.Services.AddSqlSimCityHttpSecurity(builder.Configuration);
builder.Services.AddSqlSimCityResponseCompression();
builder.Services.AddEdgeIngestion(builder.Configuration);

// Read now rather than per request, so an unparseable value stops startup instead of
// surfacing as a 500 long after the operator has stopped watching.
var securityNoticeAcknowledged = DeploymentNotice.IsAcknowledged(builder.Configuration);

if (archiveMode)
{
    builder.Services.AddArchiveSource(builder.Configuration);
}
else if (edgeMode)
{
    builder.Services.AddEdgeAcquisitionSource(builder.Configuration);
}
else
{
    var capabilitiesSource = await FixtureCapabilitiesSource.CreateAsync(
        cancellationToken: CancellationToken.None);
    builder.Services.AddSingleton<ICapabilitiesSource>(capabilitiesSource);
    // LiveIncidents:Mode defaults to Fixture (no credentials); Connected opts a real
    // SqlConnectionFactory-backed collector in and fails closed before the host serves traffic.
    builder.Services.AddLiveIncidents(builder.Configuration, probeCatalog);
    builder.Services.AddSingleton<LiveIncidentSamplerService>();
    builder.Services.AddSingleton<ILiveIncidentResponseSource>(
        services => services.GetRequiredService<LiveIncidentSamplerService>());
    builder.Services.AddHostedService(services => services.GetRequiredService<LiveIncidentSamplerService>());
}
builder.Services.AddFindings();

if (acquisitionMode == AcquisitionMode.Fixture && atlasConnected)
{
    var atlasConnectionString = AtlasConfiguration.TryParseConnectionString(builder.Configuration);
    var atlasOptions = AtlasConfiguration.BuildCollectionOptions(builder.Configuration, atlasConnectionString);
    var connectionProfile = AtlasConfiguration.BuildProfile(builder.Configuration, atlasConnectionString);
    builder.Services.AddSingleton(atlasOptions);
    builder.Services.AddSingleton(connectionProfile);
    builder.Services.AddSingleton(TimeProvider.System);
    builder.Services.AddSingleton(
        AtlasConfiguration.BuildSecretProvider(builder.Configuration, atlasConnectionString));
    builder.Services.AddSingleton<ISqlConnectionFactory>(services =>
        new SqlConnectionFactory(services.GetRequiredService<ISecretFileProvider>()));
    builder.Services.AddSingleton<IAtlasProbeExecutor, SqlClientAtlasProbeExecutor>();
    builder.Services.AddSingleton<ILiveAtlasActivitySource>(services =>
        new LiveIncidentAtlasActivitySource(
            () => services.GetRequiredService<LiveIncidentSamplerService>().GetCurrentResponse(),
            atlasOptions.TargetId));
    builder.Services.AddSingleton<AtlasCollector>();
    builder.Services.AddSingleton<IReconnectJitter, RandomReconnectJitter>();
    builder.Services.AddSingleton<IReconnectBackoff>(services =>
        new ExponentialReconnectBackoff(
            TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(5),
            services.GetRequiredService<IReconnectJitter>()));
    builder.Services.AddSingleton<AtlasRefreshCoordinator>();
    builder.Services.AddSingleton<ConnectedAtlasSource>();
    builder.Services.AddSingleton<IAtlasSnapshotSource>(services => services.GetRequiredService<ConnectedAtlasSource>());
    builder.Services.AddSingleton<IAtlasCollectorStatusSource>(services => services.GetRequiredService<ConnectedAtlasSource>());
    builder.Services.AddSingleton<IDatabaseCityProbeExecutor, SqlClientDatabaseCityProbeExecutor>();
    builder.Services.AddSingleton<IDatabaseCitySource>(services => new ConnectedDatabaseCitySource(
        services.GetRequiredService<IAtlasSnapshotSource>(),
        services.GetRequiredService<IDatabaseCityProbeExecutor>(),
        services.GetService<QueryStoreCityAttribution>()));
    builder.Services.AddHostedService<AtlasRefreshBackgroundService>();
    if (queryStoreConnected)
    {
        builder.Services.AddSingleton(QueryStoreHistoryConfiguration.BuildCollectionOptions(builder.Configuration));
        builder.Services.AddSingleton(QueryStoreHistoryConfiguration.BuildHostOptions(builder.Configuration));
        builder.Services.AddSingleton<IQueryStoreIncrementalSource, SqlQueryStoreIncrementalSource>();
        builder.Services.AddSingleton<ProtectedQueryStoreRepository>();
        builder.Services.AddSingleton<QueryStoreCollectionStatusTracker>();
        builder.Services.AddSingleton<SecureShowplanParser>();
        builder.Services.AddSingleton<ProtectedQueryStoreHistorySink>();
        builder.Services.AddSingleton<IQueryStoreHistorySink>(services =>
            services.GetRequiredService<ProtectedQueryStoreHistorySink>());
        builder.Services.AddSingleton<IncrementalQueryStoreCollector>();
        builder.Services.AddSingleton<ConnectedQueryStoreHistorySource>();
        builder.Services.AddSingleton<IQueryStoreHistorySource>(services =>
            services.GetRequiredService<ConnectedQueryStoreHistorySource>());
        // Joins Query Store families to catalog objects so the live map shows attributed
        // exposure, co-reference roads, and wait lanes instead of an unattributed city.
        builder.Services.AddSingleton<QueryStoreCityAttribution>();
        builder.Services.AddHostedService<QueryStoreHistoryBackgroundService>();
    }
    else
    {
        builder.Services.AddSingleton<IQueryStoreHistorySource, UnavailableQueryStoreHistorySource>();
    }
}
else if (acquisitionMode == AcquisitionMode.Fixture)
{
    builder.Services.AddSingleton<FixtureAtlasSnapshotSource>();
    builder.Services.AddSingleton<IAtlasSnapshotSource>(services => services.GetRequiredService<FixtureAtlasSnapshotSource>());
    builder.Services.AddSingleton<IAtlasCollectorStatusSource>(services => services.GetRequiredService<FixtureAtlasSnapshotSource>());
    builder.Services.AddSingleton<IQueryStoreHistorySource, FixtureQueryStoreHistorySource>();
    builder.Services.AddSingleton<IDatabaseCitySource, FixtureDatabaseCitySource>();
}

var app = builder.Build();

// A connection string password lives in this process's environment and cannot be
// rotated without a restart, unlike the mounted secret files every other path uses.
// Say so once at startup rather than letting the trade-off pass silently.
SqlSimCityConnectionString.WarnIfConfigured(
    builder.Configuration, app.Services.GetRequiredService<ILoggerFactory>());

// Retained evidence is readable by anyone who can read the data directory; say so
// once at startup rather than letting an operator discover it later.
ProtectedStorageAutoProvisioning.Report(
    protectedStorageProvisioning, app.Services.GetRequiredService<ILoggerFactory>());

// Protected storage is opt-in and fails closed: when enabled, an unusable data
// directory, corrupt canary, or migration error must stop the process before it
// serves traffic rather than silently collecting nothing.
var protectedStorageInitializer = app.Services.GetService<IProtectedStorageInitializer>();
if (protectedStorageInitializer is not null)
{
    await protectedStorageInitializer.EnsureReadyAsync(app.Lifetime.ApplicationStopping);
}

// Ahead of everything else: the rate limiter below partitions on the connection's
// remote address, so a forwarded client address has to be in place before it runs.
// Disabled by default, in which case this adds no middleware at all.
app.UseSqlSimCityReverseProxy();

app.Use(async (context, next) =>
{
    context.Response.Headers.ContentSecurityPolicy =
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; " +
        "font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; " +
        "base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
    context.Response.Headers.XContentTypeOptions = "nosniff";
    context.Response.Headers.XFrameOptions = "DENY";
    context.Response.Headers["Referrer-Policy"] = "no-referrer";
    context.Response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
    context.Response.Headers["Cross-Origin-Opener-Policy"] = "same-origin";
    await next();
});
app.UseSqlSimCityHttpSecurity();

// Ahead of the API routes it compresses, and after the security headers above so those
// are never themselves subject to negotiation. Static assets do not reach this: they are
// served pre-compressed by MapStaticAssets below, which sets Content-Encoding itself and
// so is skipped here.
app.UseResponseCompression();
app.UseSqlSimCityImmutableAssets();

// Rewrites "/" to "/index.html" so the request matches the static asset endpoint (and its
// pre-compressed, ETagged representation) instead of falling through to the SPA fallback.
app.UseDefaultFiles();
// The .NET SDK already compresses every static web asset at publish time and records the
// per-encoding ETag, `Vary`, and cache lifetime in a manifest. Serving from that manifest
// is both smaller and cheaper than compressing on the fly: three.js is 134,613 bytes here
// against 164,740 for on-the-fly Brotli, and costs no CPU per request rather than ~8 ms.
// It also fingerprints assets and marks them `immutable`, which UseStaticFiles never did.
app.MapStaticAssets();

app.MapGet("/healthz", () => Results.Ok(new { status = "healthy" }));
app.MapGet("/readyz", () => Results.Ok(new { status = "ready" }));
app.MapGet("/api/v1/atlas", (IAtlasSnapshotSource source, HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return Results.Ok(source.GetCurrent());
});
app.MapGet("/api/v1/atlas/status", (IAtlasCollectorStatusSource source, HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return Results.Ok(source.GetStatus());
});
app.MapGet("/api/v1/capabilities", (ICapabilitiesSource source, HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return Results.Ok(source.GetCurrent());
});
// Whether the browser draws the "no login of its own" notice. Acknowledging it is a
// display decision only: the startup warnings in this process's log are untouched.
app.MapGet("/api/v1/deployment", (HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return Results.Ok(new
    {
        schemaVersion = "1.0",
        securityNoticeAcknowledged,
    });
});
app.MapGet("/api/v1/live", (ILiveIncidentResponseSource source, HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return Results.Ok(source.GetCurrentResponse());
});

var queryStore = app.MapGroup("/api/v1/query-store");
queryStore.MapGet("/queries", async (
    IQueryStoreHistorySource source,
    HttpContext context,
    string? databaseId,
    string? metric,
    int? pageSize,
    string? pageToken,
    CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    var selectedMetric = metric ?? "cpu";
    if (selectedMetric is not ("cpu" or "execution" or "executions" or "duration" or "reads" or "waits"))
        return Results.BadRequest(new { error = "metric must be cpu, execution, duration, reads, or waits." });
    var selectedPageSize = pageSize ?? 50;
    if (selectedPageSize is < 1 or > 200)
        return Results.BadRequest(new { error = "pageSize must be between 1 and 200." });
    try
    {
        return Results.Ok(await source.GetQueriesAsync(
            databaseId, selectedMetric, selectedPageSize, pageToken, cancellationToken));
    }
    catch (QueryStorePageTokenException)
    {
        return Results.BadRequest(new { error = "pageToken is malformed or no longer valid." });
    }
    catch (QueryStoreSnapshotChangedException)
    {
        return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }
});
queryStore.MapGet("/queries/{familyId}", async (
    IQueryStoreHistorySource source, HttpContext context, string familyId, CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    try
    {
        return await source.GetFamilyAsync(familyId, cancellationToken) is { } family
            ? Results.Ok(family) : Results.NotFound();
    }
    catch (QueryStoreSnapshotChangedException)
    {
        return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }
});
queryStore.MapGet("/queries/{familyId}/timeline", async (
    IQueryStoreHistorySource source, HttpContext context, string familyId, CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    try
    {
        return await source.GetFamilyAsync(familyId, cancellationToken) is { } family
            ? Results.Ok(new { schemaVersion = "1.0", items = family.Runtime })
            : Results.NotFound();
    }
    catch (QueryStoreSnapshotChangedException)
    {
        return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }
});
queryStore.MapGet("/queries/{familyId}/plans", async (
    IQueryStoreHistorySource source, HttpContext context, string familyId, CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    try
    {
        return await source.GetFamilyAsync(familyId, cancellationToken) is { } family
            ? Results.Ok(new { schemaVersion = "1.0", items = family.Plans })
            : Results.NotFound();
    }
    catch (QueryStoreSnapshotChangedException)
    {
        return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }
});
queryStore.MapGet("/plans/{planId}", async (
    IQueryStoreHistorySource source, HttpContext context, string planId, CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    try
    {
        return await source.GetPlanAsync(planId, cancellationToken) is { } plan
            ? Results.Ok(plan) : Results.NotFound();
    }
    // The Showplan exists but exceeds a parser bound or is malformed. That is a fact about this plan,
    // not a server fault, so it is reported with its reason instead of an opaque 500.
    catch (XmlException ex)
    {
        return Results.Json(
            new { error = $"This Showplan could not be normalized. {ex.Message}" },
            statusCode: StatusCodes.Status422UnprocessableEntity);
    }
});
queryStore.MapGet("/plans/compare", async (
    IQueryStoreHistorySource source, HttpContext context, string leftPlanId, string rightPlanId,
    CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    try
    {
        return await source.ComparePlansAsync(leftPlanId, rightPlanId, cancellationToken) is { } comparison
            ? Results.Ok(comparison)
            : Results.NotFound();
    }
    catch (XmlException ex)
    {
        return Results.Json(
            new { error = $"One of these Showplans could not be normalized, so no comparison is claimed. {ex.Message}" },
            statusCode: StatusCodes.Status422UnprocessableEntity);
    }
});
queryStore.MapGet("/status", async (
    IQueryStoreHistorySource source, HttpContext context, CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return Results.Ok(await source.GetStatusAsync(cancellationToken));
});
app.MapDatabaseCity();
if (archiveMode || edgeMode)
{
    if (archiveMode)
        app.MapArchiveInfo();
    else
        app.MapGet("/api/v1/archive", () => Results.NotFound());
    app.MapMethods("/hubs/current-snapshot", ["GET", "POST"], () => Results.NotFound());
    app.MapMethods("/hubs/current-snapshot/{**rest}", ["GET", "POST"], () => Results.NotFound());
}
else
{
    app.MapGet("/api/v1/archive", () => Results.NotFound());
    app.MapHub<CurrentSnapshotHub>("/hubs/current-snapshot");
}
app.MapFindings();
app.MapEdgeIngestion();
if (edgeMode)
{
    app.MapGet("/api/v1/edge/source", (EdgeAcquisitionSource source, HttpContext context) =>
    {
        context.Response.Headers.CacheControl = "no-store";
        return Results.Ok(source.Info);
    });
}
else
{
    app.MapGet("/api/v1/edge/source", () => Results.NotFound());
}
app.MapFallbackToFile("index.html");

app.Run();
