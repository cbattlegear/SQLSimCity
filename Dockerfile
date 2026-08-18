# syntax=docker/dockerfile:1.7
FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS web-build
WORKDIR /source/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:e1ffd2a92ae84c1291bc1b6887501f8af98e6331e7af6d4c8d37168c5e87a64c AS api-build
ARG SOURCE_DATE_EPOCH=0
ENV SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH
WORKDIR /source
COPY SqlSimCity.slnx Directory.Build.props Directory.Packages.props ./
COPY src/SqlSimCity.Api/SqlSimCity.Api.csproj src/SqlSimCity.Api/
COPY src/SqlSimCity.Api/packages.lock.json src/SqlSimCity.Api/
COPY src/SqlSimCity.Archive/SqlSimCity.Archive.csproj src/SqlSimCity.Archive/
COPY src/SqlSimCity.Archive/packages.lock.json src/SqlSimCity.Archive/
COPY src/SqlSimCity.Domain/SqlSimCity.Domain.csproj src/SqlSimCity.Domain/
COPY src/SqlSimCity.Domain/packages.lock.json src/SqlSimCity.Domain/
COPY src/SqlSimCity.Contracts/SqlSimCity.Contracts.csproj src/SqlSimCity.Contracts/
COPY src/SqlSimCity.Contracts/packages.lock.json src/SqlSimCity.Contracts/
COPY src/SqlSimCity.Storage/SqlSimCity.Storage.csproj src/SqlSimCity.Storage/
COPY src/SqlSimCity.Storage/packages.lock.json src/SqlSimCity.Storage/
COPY src/SqlSimCity.SqlServer/SqlSimCity.SqlServer.csproj src/SqlSimCity.SqlServer/
COPY src/SqlSimCity.SqlServer/packages.lock.json src/SqlSimCity.SqlServer/
COPY src/SqlSimCity.Collection/SqlSimCity.Collection.csproj src/SqlSimCity.Collection/
COPY src/SqlSimCity.Collection/packages.lock.json src/SqlSimCity.Collection/
COPY src/SqlSimCity.Findings/SqlSimCity.Findings.csproj src/SqlSimCity.Findings/
COPY src/SqlSimCity.Findings/packages.lock.json src/SqlSimCity.Findings/
COPY src/SqlSimCity.Edge/SqlSimCity.Edge.csproj src/SqlSimCity.Edge/
COPY src/SqlSimCity.Edge/packages.lock.json src/SqlSimCity.Edge/
RUN dotnet restore src/SqlSimCity.Api/SqlSimCity.Api.csproj --locked-mode
COPY src/ src/
COPY sql/ sql/
COPY fixtures/ fixtures/
COPY --from=web-build /source/web/dist web/dist
RUN dotnet publish src/SqlSimCity.Api/SqlSimCity.Api.csproj \
    --configuration Release \
    --no-restore \
    --output /app/publish \
    -p:ContinuousIntegrationBuild=true \
    -p:Deterministic=true \
    -p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0@sha256:a4556ed033fa96f984bb7a8d348851cb2d36b1281dd2420070045f664fbb5f94 AS runtime
ARG BUILD_DATE
ARG VERSION=0.0.0-local
ARG REVISION=unknown
ARG SOURCE=https://github.com/cbattlegear/SQLSimCity
LABEL org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.description="Read-only SQL Server operational evidence explorer" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.source=$SOURCE \
      org.opencontainers.image.title="SQLSimCity" \
      org.opencontainers.image.version=$VERSION
WORKDIR /app
RUN mkdir /data && chown $APP_UID:$APP_UID /data
COPY --from=api-build --chown=$APP_UID:$APP_UID /app/publish ./
COPY --chown=$APP_UID:$APP_UID LICENSE NOTICE /app/legal/
ENV ASPNETCORE_HTTP_PORTS=8080 \
    DOTNET_EnableDiagnostics=0 \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "SqlSimCity.Api.dll"]
