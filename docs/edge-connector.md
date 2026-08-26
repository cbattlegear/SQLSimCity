# SQLSimCity edge connector

The edge connector monitors SQL Servers that the central SQLSimCity container **cannot reach**. A
small connector process runs near SQL Server, connects **outward** to a configured central ingestion
endpoint over HTTPS, and forwards the same source-neutral observations the built-in collectors
produce. It never accepts inbound control, never centralizes SQL credentials, and never mutates SQL
Server.

This document covers deployment, security, and operations. For the transport contract and internals,
see the `SqlSimCity.Edge` and `SqlSimCity.Edge.Connector` projects.

> **No live SQL target validated.** As with the rest of SQLSimCity, the connector ships with a
> deterministic fixture observation provider and an opt-in connected provider built from the same
> production collectors as central connected mode. End-to-end validation used fixtures and fake probe
> executors only; no real SQL Server was contacted during development.

## Architecture

```text
[ SQL Server ] <-- read-only --> [ edge connector ]  --HTTPS + HMAC-->  [ central SQLSimCity ]
                                   |  bounded encrypted spool                 |  opt-in POST /api/v1/edge/ingest
                                   |  outward only, no inbound API            |  verify -> validate -> ingest
                                                                              |  complete generation -> existing APIs
```

- The connector packages evidence into a versioned **observation envelope** (`ObservationEnvelopeV1`)
  and batches (`ObservationBatchV1`): opaque connector/target ids, per-target sequence, boot epoch,
  captured time, section/chunk type, content digest, idempotency key, compression, and source
  freshness. Raw SQL and Showplan XML are never transmitted; text and plans are normalized/redacted by
  the producing seam before they reach the envelope.
- Delivery is **durable and ordered**: every batch is sealed into a bounded AES-256-GCM spool first,
  then drained oldest-first. Offline windows never lose evidence up to the spool bound.
- The central server ingests only in explicit `Acquisition:Mode=Edge`. The normal application stays
  GET-only; Edge mode adds exactly one bounded `POST /api/v1/edge/ingest` and requires one exact
  allowlisted target id.

## Security model

- **Transport.** HTTPS only. Plain HTTP is refused unless the endpoint is an explicit loopback
  development address (`SQLSIMCITY_EDGE_ALLOW_LOOPBACK_HTTP=true`). The connector disables HTTP
  redirect following so a downgrade to `http://` cannot be forced.
- **Authentication.** Each request is signed with **HMAC-SHA-256** over a canonical string of method,
  path, timestamp, nonce, connector id, key id, and the body's SHA-256 digest. The central server
  verifies in constant time, enforces a bounded clock skew, rejects connectors not on its allowlist,
  rejects unknown key ids, and persists accepted nonces to a durable journal so a captured request
  cannot be replayed even across a central restart.
- **Secrets are files, never environment plaintext.** The connector's HMAC secret and spool key are
  read from files/Docker secrets. The central allowlist and per-connector secrets come from a catalog
  file plus a secrets directory. There is no fallback secret and no `DefaultAzureCredential`/interactive
  auth anywhere in this path.
- **Key rotation.** A connector key id lets old and new secrets overlap: add the new key to the
  central catalog, roll the connector's `SQLSIMCITY_EDGE_KEY_ID` and secret file, then retire the old
  catalog entry.
- **Spool encryption.** Spooled batches are AES-256-GCM sealed with a **separate** mounted key,
  written atomically (temp + rename), one writer, no symlink/traversal/special files. A wrong or
  corrupt key fails closed.
- **Central hardening.** The ingest endpoint enforces strict `Content-Type`/`Content-Length`, a body
  bound, the global API limit plus a configured per-client edge limit,
  schema/digest/signature/sequence/epoch/standard-payload validation, safe gzip decompression
  (compression-bomb guarded), atomic all-or-nothing publication, bounded idempotent duplicate
  acceptance, and conflict rejection. Curated errors never echo secrets, headers, or payloads.

## Central configuration (`EdgeIngestion` section)

Disabled by default. Set `Acquisition:Mode=Edge`, configure the single source target, then enable:

| Setting | Meaning |
| --- | --- |
| `EdgeIngestion:Enabled` | `true` to map the ingestion endpoint. |
| `Acquisition:Edge:TargetId` | Exact target id this source projects; all other targets are rejected. |
| `Acquisition:Edge:StaleAfterSeconds` | Fallback staleness age when a section has no `FreshUntil` (default 90). |
| `Acquisition:Edge:DisconnectAfterSeconds` | Generation age that marks the source disconnected (default 300). |
| `EdgeIngestion:SecretCatalogFile` | Path to the connector allowlist/secret catalog JSON. |
| `EdgeIngestion:SecretsDirectory` | Directory holding the per-connector secret files. |
| `EdgeIngestion:NonceJournalPath` | Durable replay-nonce journal path (persist across restarts). |
| `EdgeIngestion:ClockSkewSeconds` | Allowed timestamp skew (default 300). |
| `EdgeIngestion:MaxBatchBytes` | Maximum accepted batch body size (default 4 MiB). |
| `EdgeIngestion:RateLimitPermitPerMinute` | Per-client ingest limit, in addition to the global API limiter (default 120). |
| `EdgeIngestion:MaxPendingBytesPerTarget` | Buffered bytes one target may hold across in-progress section groups (default 160 MiB). |
| `EdgeIngestion:MaxPendingBytesTotal` | Buffered bytes across every target (default 320 MiB). |
| `EdgeIngestion:MaxPendingGroupsPerTarget` | In-progress section groups one target may hold open (default 64). |
| `EdgeIngestion:MaxTargets` | Distinct targets the observation store will hold state for (default 64). |

### Bounded central residency

A section is capped at 32 MiB reassembled, but that cap is **per section group**, so the four
settings above bound the aggregate. Without them an aggressive or hostile connector can grow resident
memory without limit by opening many partial groups, many sections, or many targets at once.

The defaults bound the pathological case, not the legitimate one: 160 MiB per target is exactly five
sections at the 32 MiB reassembly cap, so nothing a connector can legally do under the existing
per-section bound is rejected by the aggregate one. Lower them if you want a tighter memory ceiling
than the per-section caps imply, and remember that pending bytes are resident memory.

Every bound fails closed with a `422` and a fixed, non-secret reason; evidence is never silently
dropped, and a rejected batch leaves no trace — its buffers are not retained. Incoherent values (a
per-target bound below `MaxBatchBytes`, or a total below the per-target bound) are rejected at
startup rather than silently clamped.

### Connector secret catalog

```json
{
  "formatVersion": 1,
  "connectors": [
    { "connectorId": "edge-a", "keys": [ { "keyId": "2026-08", "secretFile": "edge-a-hmac" } ] }
  ]
}
```

`secretFile` must be a **simple file name** resolved strictly under `SecretsDirectory`; path
separators, `..`, and rooted paths are rejected. Each secret file holds base64 of at least 32 bytes.

## Connector configuration (environment)

| Variable | Meaning |
| --- | --- |
| `SQLSIMCITY_EDGE_CONNECTOR_ID` | Opaque connector identity (must be allowlisted centrally). |
| `SQLSIMCITY_EDGE_TARGET_ID` | Opaque monitored-target identity. |
| `SQLSIMCITY_EDGE_KEY_ID` | Signing key id (for rotation). |
| `SQLSIMCITY_EDGE_SOURCE_MODE` | `Fixture` (default) or `Connected`. |
| `SQLSIMCITY_EDGE_INGEST_ENDPOINT` | Absolute central ingestion URL (HTTPS in production). |
| `SQLSIMCITY_EDGE_SIGNING_SECRET_FILE` | File holding the base64 HMAC secret. |
| `SQLSIMCITY_EDGE_SPOOL_DIR` | Spool directory (a bounded volume). |
| `SQLSIMCITY_EDGE_SPOOL_KEY_FILE` | Separate AES-256 spool key file. |
| `SQLSIMCITY_EDGE_FIXTURES_DIR` | Directory of the validated fixtures the connector forwards. |
| `SQLSIMCITY_EDGE_COLLECT_INTERVAL_SECONDS` | Collection cadence (default 15). |
| `SQLSIMCITY_EDGE_COLLECT_MAX_BACKOFF_SECONDS` | Ceiling on the decayed collection cadence during spool backpressure (default 300; 0 disables backoff). |
| `SQLSIMCITY_EDGE_DELIVER_INTERVAL_SECONDS` | Delivery cadence (default 5). |
| `SQLSIMCITY_EDGE_SPOOL_MAX_BYTES` / `_MAX_ITEMS` / `_MAX_AGE_SECONDS` | Spool bounds. |
| `SQLSIMCITY_EDGE_ALLOW_LOOPBACK_HTTP` | Allow plain HTTP only for a loopback dev endpoint. |
| `SQLSIMCITY_EDGE_LOOPBACK_HEALTH_PORT` | Optional loopback-only generic health port (0 disables). |

### Connected SQL source

`Connected` uses `SqlConnectionFactory` and the production live, Atlas, capability, incremental
Query Store, and database-city collectors. Collector instances, delta baselines, Query Store
watermarks, and the bounded volatile protected-record store persist across connector cycles. The
store is capped at 4,096 records, 1 MiB per record, and 64 MiB total; it never writes plaintext to
disk and clears rejected/replaced/disposed buffers. Restarting the
connector starts a new transport epoch and intentionally resets that in-process history.

The complete profile is required before the process starts. Either set
`SQLSIMCITY_EDGE_SQL_CONNECTION_STRING` (see [the shortcut below](#development-shortcut-sqlsimcity_edge_sql_connection_string))
or configure these fields:

| Variable | Meaning |
| --- | --- |
| `SQLSIMCITY_EDGE_SQL_HOST` | SQL Server DNS name or IPv4 address. |
| `SQLSIMCITY_EDGE_SQL_PORT` / `_INSTANCE` | Optional port or named instance; configure at most one. |
| `SQLSIMCITY_EDGE_SQL_INITIAL_DATABASE` | Initial/contained database. |
| `SQLSIMCITY_EDGE_SQL_PLATFORM` | `SqlServerOnPremises`, `AzureSqlDatabase`, or `AzureSqlManagedInstance`; inferred only from a connection string host. |
| `SQLSIMCITY_EDGE_SQL_TARGET_DISPLAY_NAME` | Non-secret display label. |
| `SQLSIMCITY_EDGE_SQL_KNOWN_DATABASES` | Comma-separated, unique names (maximum 100). Required for Azure SQL Database. |
| `SQLSIMCITY_EDGE_SQL_CONNECT_TIMEOUT_SECONDS` / `_COMMAND_TIMEOUT_SECONDS` | Bounded connection/command timeouts (defaults 15/30). |
| `SQLSIMCITY_EDGE_SQL_MIN_POOL_SIZE` / `_MAX_POOL_SIZE` | Validated pool bounds (defaults 0/20). |
| `SQLSIMCITY_EDGE_SQL_ENCRYPTION` | `Mandatory` (default) or `Strict`. |
| `SQLSIMCITY_EDGE_SQL_HOST_NAME_IN_CERTIFICATE` | Optional explicit TLS certificate host. |
| `SQLSIMCITY_EDGE_SQL_TRUST_SERVER_CERTIFICATE` | Explicit per-profile opt-in; incompatible with `Strict`. |
| `SQLSIMCITY_EDGE_SQL_SECRETS_DIR` | Directory containing SQL authentication files (default `/run/secrets`). |
| `SQLSIMCITY_EDGE_SQL_DATABASE_CONCURRENCY` | Atlas/Query Store database concurrency, 1–16 (default 4). |
| `SQLSIMCITY_EDGE_SQL_QUERY_STORE_WINDOW_MINUTES` | Atlas Query Store window (default 1440). |
| `SQLSIMCITY_EDGE_SQL_QUERY_STORE_PAGE_SIZE` | Incremental page bound, 1–10000 (default 1000). |
| `SQLSIMCITY_EDGE_SQL_QUERY_STORE_OVERLAP_MINUTES` | Incremental overlap, 0–1440 (default 65). |

Select exactly one `SQLSIMCITY_EDGE_SQL_AUTH_MODE`:

- `SqlLogin`: `SQL_USERNAME` plus `SQL_PASSWORD_SECRET_FILE`.
- `Kerberos`: the container service identity and standard `KRB5_CONFIG`/`KRB5_KTNAME` mounted-file
  deployment described in `SECURITY.md`; no password fallback exists.
- `ManagedIdentity`: optional `SQL_USER_ASSIGNED_CLIENT_ID`.
- `WorkloadIdentity`: `SQL_TENANT_ID`, `SQL_CLIENT_ID`, and
  `SQL_FEDERATED_TOKEN_FILE` (a simple file name resolved under `SQL_SECRETS_DIR`).
- `ServicePrincipalCertificate`: `SQL_TENANT_ID`, `SQL_CLIENT_ID`,
  `SQL_CERTIFICATE_SECRET_FILE`, and optional `SQL_CERTIFICATE_PASSWORD_SECRET_FILE`.
- `ServicePrincipalSecret`: `SQL_TENANT_ID`, `SQL_CLIENT_ID`, and
  `SQL_CLIENT_SECRET_FILE`.

Every name above is appended to the `SQLSIMCITY_EDGE_` prefix. Secret values in environment
variables are rejected; configured authentication files are preflighted before collection starts.
There is no `DefaultAzureCredential`, interactive login, credential chain, or auth fallback.

#### Development shortcut: `SQLSIMCITY_EDGE_SQL_CONNECTION_STRING`

`SQLSIMCITY_EDGE_SQL_CONNECTION_STRING` accepts one ordinary ADO.NET connection string in place of
the connection fields above:

```text
SQLSIMCITY_EDGE_SOURCE_MODE=Connected
SQLSIMCITY_EDGE_SQL_CONNECTION_STRING=Server=sql01.example.internal,1433;Database=appdb;User Id=collector;Password=...;TrustServerCertificate=true
```

It is parsed into exactly the same validated `ConnectionProfile` the fields produce, so the password
still never reaches a connection string, log, or diagnostic — it is passed as a `SqlCredential` —
and `ApplicationIntent=ReadOnly` is still forced.

**It is the one deliberate exception to the rule that no secret comes from an environment
variable.** A password here is readable by anything that can read the connector's environment and
cannot be rotated without a restart. The connector logs a `warn` event at startup when one is in
use. Mounted secret files remain the deployment default.

Rules:

- It cannot be combined with any field it already covers — `SQL_HOST`, `_INSTANCE`, `_PORT`,
  `_INITIAL_DATABASE`, `_AUTH_MODE`, `_USERNAME`, `_PASSWORD_SECRET_FILE`, `_ENCRYPTION`,
  `_TRUST_SERVER_CERTIFICATE`, `_HOST_NAME_IN_CERTIFICATE`, `_CONNECT_TIMEOUT_SECONDS`,
  `_COMMAND_TIMEOUT_SECONDS`, `_MIN_POOL_SIZE`, `_MAX_POOL_SIZE`, `_USER_ASSIGNED_CLIENT_ID`,
  `_TENANT_ID`, `_CLIENT_ID`, `_FEDERATED_TOKEN_FILE`, `_CLIENT_SECRET_FILE`,
  `_CERTIFICATE_SECRET_FILE`, `_CERTIFICATE_PASSWORD_SECRET_FILE`. Setting both is rejected rather
  than one silently winning — most importantly for `_USER_ASSIGNED_CLIENT_ID`, where the connection
  string's own `User Id` would otherwise take effect and authenticate as the system-assigned
  identity with no error.
- Fields it cannot express still apply: `SQL_TARGET_DISPLAY_NAME` (defaults to
  `SQLSIMCITY_EDGE_TARGET_ID`), `SQL_KNOWN_DATABASES`, and the collection tuning variables.
- `SQL_PLATFORM` becomes optional and is inferred from the host name — `*.database.windows.net` is
  taken as Azure SQL Database, everything else as SQL Server on-premises. Managed Instance shares
  that suffix, so it must still be stated explicitly. For Azure SQL Database, `SQL_KNOWN_DATABASES`
  defaults to the connection string's own `Database`.
- Only SQL login, `Integrated Security=true` (Kerberos), and
  `Authentication=Active Directory Managed Identity` are supported. Workload identity and service
  principal need a tenant id a connection string cannot carry, and `Active Directory Default` stays
  banned; use the fields above for those.
- `Encrypt=false` and infinite (`0`) timeouts are rejected, as they are on the field path.
- `Max Pool Size` defaults to 20, matching the field path, not SqlClient's own default of 100.
- `Server=admin:host` (dedicated administrator connection), `np:`, and `lpc:` are rejected. The
  connector rebuilds the connection as TCP, so it cannot honor them; connecting to an ordinary
  endpoint instead, silently, would be worse. `tcp:` is accepted.
- The prohibition on plaintext secret variables (`SQL_PASSWORD`, `SQL_CLIENT_SECRET`,
  `SQL_CERTIFICATE_PASSWORD`, `SQL_FEDERATED_TOKEN`) is unchanged and still enforced.

The connector fetches Query Store normalized facts only. It never calls the raw query-text or
Showplan XML lookup methods. Its live probes set `@IncludeSqlText=0`, which prevents
`sys.dm_exec_sql_text` invocation; login, host, program, and any defensive text fields are also
cleared before the envelope is built.

Spool key file format:

```json
{ "formatVersion": 1, "keyVersion": 1, "key": "<base64 of exactly 32 bytes>" }
```

## Backpressure and cadence

- Bounded collection and delivery loops never overlap a cycle with the previous one.
- Exceeding a spool bound applies **explicit backpressure** (the batch is rejected and the connector
  reports paused) — never a silent drop. Age-based pruning reports a `droppedByAge` count.
- After a rejection the **collection cadence decays exponentially**, up to
  `SQLSIMCITY_EDGE_COLLECT_MAX_BACKOFF_SECONDS`, so a long outage stops charging the monitored SQL
  Server a full query/serialize/compress/encrypt cycle every 15 seconds for evidence that cannot be
  stored. The connector keeps trying at the decayed rate and recovers on its own once delivery frees
  space — no operator action, and no separate reset.
  Collection is deliberately **not** gated on the paused flag. That flag is set by a rejection and
  cleared only by a *successful enqueue*, never merely by delivery draining space, so skipping
  collection while paused would suppress the very enqueue that clears it and the connector would
  never recover. The `connector.backpressure` event reports the next cadence as `nextCollectSeconds`.
- Transient failures back off exponentially with jitter. `429` honors `Retry-After`. A `413` splits
  the batch at existing chunk boundaries and re-spools the halves. An authentication failure **stops**
  delivery instead of retry-storming; it clears when credentials are corrected.
- On shutdown the connector performs one bounded final drain; anything unsent stays safely spooled for
  the next run.

## Least-privilege SQL grants

The connector uses the same read-only collection as connected central mode. Grant the connector login
`VIEW SERVER STATE` + `VIEW DATABASE STATE` (SQL Server 2016–2019) or `VIEW SERVER PERFORMANCE STATE`
+ `VIEW DATABASE PERFORMANCE STATE` (SQL Server 2022+), plus `CONNECT` to each collected database.
SQLSimCity never executes grants. See the main `README.md` and `SECURITY.md`.

Permit outbound traffic only to the configured central HTTPS endpoint and SQL Server endpoint.
Microsoft Entra modes additionally require the documented authority/token endpoints; managed identity
requires its platform identity endpoint, workload identity requires its mounted token, and Kerberos
requires DNS plus KDC/realm traffic. No inbound connector control port is required.

## Central projection and status

When Edge mode is enabled, the central server exposes read-only, `no-store` status:

- `GET /api/v1/edge/status` and `GET /api/v1/edge/targets` — per-target status (connector id, last
  sequence, epoch, freshness, published sections). Generic; no secrets.
- `GET /api/v1/edge/targets/{targetId}/sections/{section}` — the reconstructed observation generation
  for one delivered section.
- `GET /api/v1/edge/source` — the selected target's compact source/status projection.

Atlas, capabilities, Query Store, database-city, live, and findings use the same existing API routes
in Edge mode. They switch atomically only when all five standard sections share one connector, target,
epoch, boot, and sequence; a partial next generation is never projected. The UI shows a compact
source/status/target panel and Edge source labels. A connector that stops delivering goes
stale/disconnected. Imported live evidence is always a static point-in-time sample; the central
service starts no sampler, SQL collection, or SignalR trace.

The replay nonce journal is durable across central restarts. Accepted observation generations and
bounded idempotency indexes are in-memory; after a central restart the source waits for the connector's
next generation. A nonce already accepted before restart remains rejected, so replay protection never
reopens. Treat this as a current availability limitation, not a delivery guarantee.

## Runnable local Compose

`compose.edge.yaml` shares the connector's network namespace with `sqlsimcity-central` and uses
`http://127.0.0.1:8080`. `SQLSIMCITY_EDGE_ALLOW_LOOPBACK_HTTP=true` is safe only in that concrete
shared-loopback example. Do not copy it to a bridged service name or remote host; production remains
HTTPS-only. Because a shared network namespace has the central container's lifecycle, restart the
Compose services together after an explicit central-container recreation; the connector's encrypted
spool survives and drains after the paired restart.

## Spool backup is not a delivery guarantee

The spool bounds evidence retention: exceeding max bytes/items applies backpressure, and batches older
than the max age are dropped (reported, never silent). Copying the spool volume does **not** guarantee
delivery — sealed batches are only readable with the spool key, and an outage longer than the spool's
bounds necessarily drops the oldest evidence. Size the bounds for your longest expected outage.

## Troubleshooting

- **`401` from central:** connector not allowlisted, unknown key id, clock skew beyond bound, replayed
  nonce, wrong secret, or body/digest mismatch. Check the catalog, the connector's `KEY_ID`, and clock
  sync; rotate the secret if compromise is suspected.
- **`409` from central:** sequence rollback, a retired epoch replay, a reused batch id with different
  content, or a target already owned by another connector. Confirm the connector/target id mapping.
- **`413` from central:** batch exceeds `MaxBatchBytes`; the connector splits and retries automatically.
- **Connector `paused` / `droppedByAge` > 0:** the central endpoint has been unreachable long enough to
  fill or age out the spool. Restore connectivity or raise the spool bounds. While paused the
  connector collects on a decayed cadence (`nextCollectSeconds` on the `connector.backpressure`
  event) and resumes the configured interval by itself once a batch is spooled again.
- **`422` naming a buffered-evidence or target bound:** central residency limits were reached. Either
  a connector is opening more partial section groups or targets than configured, or the
  `EdgeIngestion:MaxPending*`/`MaxTargets` bounds are too tight for a legitimate workload.
- **HTTP refused at startup:** the endpoint is not HTTPS and is not a loopback dev address.
