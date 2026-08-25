using System.IO.Compression;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.DependencyInjection;

namespace SqlSimCity.Api;

/// <summary>
/// Negotiated compression for the JSON API. Static web assets are not handled here: the SDK
/// compresses them at publish time and <c>MapStaticAssets</c> serves those representations
/// directly, so they arrive with <c>Content-Encoding</c> already set and this middleware skips
/// them.
/// </summary>
public static class StaticAssetDelivery
{
    public static IServiceCollection AddSqlSimCityResponseCompression(this IServiceCollection services)
    {
        services.AddResponseCompression(options =>
        {
            // Every response this server produces is evidence that anyone who can reach the page is
            // already entitled to read in full: there is no login, no session cookie, and no CSRF
            // token (see SECURITY.md). A BREACH-style attack recovers a secret from a compressed
            // response, and there is no such secret here to recover.
            options.EnableForHttps = true;
            options.Providers.Add<BrotliCompressionProvider>();
            options.Providers.Add<GzipCompressionProvider>();
            // The defaults already cover JSON, JavaScript, CSS, and HTML. SVG is not in that list
            // and compresses well. `text/event-stream` is deliberately left out: compressing a
            // SignalR server-sent-event stream would buffer it and delay live incidents.
            options.MimeTypes = [.. ResponseCompressionDefaults.MimeTypes, "image/svg+xml"];
        });

        // Level choice is measured, not assumed. .NET maps Brotli's `Fastest` to quality 1, which on
        // this JSON is *worse* than gzip's level 1 (7,208 against 2,993 bytes for the capabilities
        // response) while costing more CPU, so preferring Brotli at `Fastest` would ship the larger
        // body of the two. `Optimal` is Brotli quality 4: it wins the comparison it is supposed to
        // win (2,139 bytes) for about 0.13 ms on the whole request. `SmallestSize` is quality 11 and
        // far too slow to run per request.
        services.Configure<BrotliCompressionProviderOptions>(
            options => options.Level = CompressionLevel.Optimal);
        services.Configure<GzipCompressionProviderOptions>(
            options => options.Level = CompressionLevel.Optimal);
        return services;
    }

    /// <summary>
    /// Vite already names every file under <c>/assets</c> after a hash of its contents, so those
    /// URLs never change meaning and can be cached for good. <c>MapStaticAssets</c> cannot know
    /// that: it only marks its *own* fingerprinted routes immutable and leaves the plain names the
    /// entry document actually references on <c>no-cache</c>, which costs a revalidation round trip
    /// per asset on every load. Restore the lifetime the file naming has already earned.
    /// </summary>
    public static WebApplication UseSqlSimCityImmutableAssets(this WebApplication app)
    {
        app.Use(static async (context, next) =>
        {
            if (HttpMethods.IsGet(context.Request.Method))
            {
                var contentAddressed = context.Request.Path.StartsWithSegments("/assets");
                context.Response.OnStarting(static state =>
                {
                    var (response, contentAddressed) = ((HttpResponse, bool))state;
                    // Only for a representation actually being served. An error response must not
                    // be cached for a year.
                    if (response.StatusCode is not (StatusCodes.Status200OK
                        or StatusCodes.Status304NotModified))
                    {
                        return Task.CompletedTask;
                    }

                    if (contentAddressed)
                    {
                        response.Headers.CacheControl = "public, max-age=31536000, immutable";
                    }
                    else if (string.IsNullOrEmpty(response.Headers.CacheControl) &&
                             response.ContentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) == true)
                    {
                        // "/" and any client-side route reach the entry document through the SPA
                        // fallback, which sets no lifetime at all -- leaving the browser free to
                        // reuse a stale document heuristically and pin an old app indefinitely.
                        // It names the hashed bundles, so it must always be revalidated.
                        response.Headers.CacheControl = "no-cache";
                    }

                    return Task.CompletedTask;
                }, (context.Response, contentAddressed));
            }

            await next();
        });
        return app;
    }
}
