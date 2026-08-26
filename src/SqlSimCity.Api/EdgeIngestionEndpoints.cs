using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Ingestion;
using SqlSimCity.Edge.Signing;

namespace SqlSimCity.Api;

public static class EdgeIngestionEndpoints
{
    /// <summary>
    /// Maps the single bounded ingestion POST plus read-only status/section endpoints — only when
    /// edge ingestion is enabled. When disabled, nothing is mapped and the app remains GET-only.
    /// </summary>
    public static WebApplication MapEdgeIngestion(this WebApplication app)
    {
        var options = app.Services.GetRequiredService<EdgeIngestionOptions>();
        if (!options.Enabled)
            return app;

        var group = app.MapGroup("/api/v1/edge");

        group.MapPost("/ingest", IngestAsync).RequireRateLimiting("edge-ingest");

        group.MapGet("/status", (EdgeIngestionContext ctx, HttpContext http) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(new { schemaVersion = "1.0", enabled = true, targets = ctx.Store.GetTargets() });
        });

        group.MapGet("/targets", (EdgeIngestionContext ctx, HttpContext http) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(new { schemaVersion = "1.0", targets = ctx.Store.GetTargets() });
        });

        group.MapGet("/targets/{targetId}/sections/{section}", (
            EdgeIngestionContext ctx, HttpContext http, string targetId, string section) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            if (!Enum.TryParse<ObservationSection>(section, ignoreCase: true, out var parsed))
                return Results.BadRequest(new { error = "Unknown observation section." });

            // Clone only the requested section: taking the whole published generation would deep-copy
            // all five sections under the store's global lock to serve one.
            var generation = ctx.Store.GetPublishedSection(targetId, parsed);
            if (generation is null)
                return Results.NotFound();

            JsonElement content;
            try
            {
                using var document = JsonDocument.Parse(generation.Content);
                content = document.RootElement.Clone();
            }
            catch (JsonException)
            {
                return Results.StatusCode(StatusCodes.Status500InternalServerError);
            }

            return Results.Ok(new
            {
                schemaVersion = "1.0",
                targetId,
                section = parsed.ToString(),
                generation.Sequence,
                generation.EpochId,
                generation.Generation,
                generation.CapturedAt,
                generation.Freshness,
                content,
            });
        });

        return app;
    }

    private static async Task<IResult> IngestAsync(HttpContext http, EdgeIngestionContext ctx)
    {
        http.Response.Headers.CacheControl = "no-store";

        // Strict content-type and content-length gate before reading any body.
        var contentType = http.Request.ContentType;
        if (contentType is null || !contentType.Contains("application/json", StringComparison.OrdinalIgnoreCase))
            return Results.StatusCode(StatusCodes.Status415UnsupportedMediaType);

        if (http.Request.ContentLength is not { } length)
            return Results.StatusCode(StatusCodes.Status411LengthRequired);
        if (length <= 0 || length > ctx.Options.MaxBatchBytes)
            return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);

        // Raise this request's body-size ceiling above the small global API limit, up to the bound.
        var sizeFeature = http.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (sizeFeature is { IsReadOnly: false })
            sizeFeature.MaxRequestBodySize = ctx.Options.MaxBatchBytes;

        var body = await ReadBoundedAsync(http.Request.Body, ctx.Options.MaxBatchBytes, http.RequestAborted);
        if (body is null)
            return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);

        // Authenticate the signed request before parsing the body content.
        var headers = http.Request.Headers;
        var verification = ctx.Verifier.Verify(
            method: "POST",
            path: http.Request.Path.Value ?? "/api/v1/edge/ingest",
            connectorId: headers[EdgeSignatureHeaders.Connector],
            keyId: headers[EdgeSignatureHeaders.KeyId],
            timestampHeader: headers[EdgeSignatureHeaders.Timestamp],
            nonce: headers[EdgeSignatureHeaders.Nonce],
            contentDigestHeader: headers[EdgeSignatureHeaders.ContentSha256],
            signatureHeader: headers[EdgeSignatureHeaders.Signature],
            body: body);

        if (!verification.IsAccepted)
        {
            // Do not reveal which specific check failed (connector/key/signature/replay); an
            // unauthenticated caller must not be able to enumerate valid connector or key ids.
            if (verification.Outcome == VerificationOutcome.Malformed)
                return Results.Json(new { error = "Malformed signed request." }, statusCode: StatusCodes.Status400BadRequest);
            return Results.Json(new { error = "Request authentication failed." }, statusCode: StatusCodes.Status401Unauthorized);
        }

        ObservationBatchV1? batch;
        try
        {
            batch = JsonSerializer.Deserialize<ObservationBatchV1>(body, EdgeJson.Options);
        }
        catch (JsonException)
        {
            return Results.BadRequest(new { error = "Batch body is not valid JSON." });
        }

        if (batch is null)
            return Results.BadRequest(new { error = "Batch body is empty." });
        if (!string.Equals(
                batch.ConnectorId,
                headers[EdgeSignatureHeaders.Connector].ToString(),
                StringComparison.Ordinal))
        {
            return Results.Json(
                new { error = "Request authentication failed." },
                statusCode: StatusCodes.Status401Unauthorized);
        }

        if (!EdgeBatchValidator.TryValidate(batch, ctx.Limits, out var chunks, out var validation))
            return Results.Json(new { error = validation.Reason }, statusCode: StatusCodes.Status422UnprocessableEntity);
        if (chunks.Any(chunk =>
                !string.Equals(chunk.TargetId, ctx.Options.AllowedTargetId, StringComparison.Ordinal)))
        {
            return Results.Json(
                new { error = "Batch target is not allowlisted for this Edge acquisition source." },
                statusCode: StatusCodes.Status422UnprocessableEntity);
        }

        var result = ctx.Store.Ingest(batch, chunks);
        return result.Outcome switch
        {
            IngestionOutcome.Accepted => Results.Json(new { status = "accepted" }, statusCode: StatusCodes.Status202Accepted),
            IngestionOutcome.DuplicateAccepted => Results.Ok(new { status = "duplicate" }),
            IngestionOutcome.Conflict => Results.Json(new { error = result.Reason }, statusCode: StatusCodes.Status409Conflict),
            _ => Results.Json(new { error = result.Reason }, statusCode: StatusCodes.Status422UnprocessableEntity),
        };
    }

    private static async Task<byte[]?> ReadBoundedAsync(Stream body, long maxBytes, CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        var rented = new byte[81920];
        int read;
        while ((read = await body.ReadAsync(rented, cancellationToken).ConfigureAwait(false)) > 0)
        {
            if (buffer.Length + read > maxBytes)
                return null;
            buffer.Write(rented, 0, read);
        }

        return buffer.ToArray();
    }
}
