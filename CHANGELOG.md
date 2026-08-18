# Changelog

All notable changes to SQLSimCity are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

SQLSimCity is independent software and is not affiliated with, sponsored by, or
endorsed by Microsoft, Electronic Arts, Maxis, or the SimCity franchise. No
SimCity assets are included.

## [Unreleased]

First MVP release candidate. There is no tagged release yet.

### Added

- **The database city is now a city.** The 3D view was rebuilt from unlabelled boxes on a rigid grid
  into a navigable street-grid town, with every encoded dimension documented and everything else
  declared as decoration:
  - **Real buildings.** Objects are placed on lots along block frontages by `web/src/cityPlan.ts` and
    given procedural per-archetype geometry by `web/src/cityBuildings.ts` — houses with pitched roofs
    and doors, rowhouses, setback midrises, and towers/skyscrapers with window grids and crowns.
    The archetype is chosen from exact reserved-page thresholds compared as `BigInt`, so a small table
    is a house and a multi-gigabyte table is a skyscraper for a measured reason. Archetype selects
    style only; measured footprint (log₂ reserved pages) and height (log₂ used pages) are unchanged.
    Unknown size stays a fenced wireframe parcel that claims no quantity.
  - **Orbit, pan, and zoom.** The camera is a full `OrbitControls` rig (left-drag orbit, right-drag
    pan, wheel zoom, damped, clamped above ground) with keyboard equivalents — arrows pan, `+`/`-`
    zoom, `[`/`]` rotate, `Home` resets — on a focusable, described canvas. Rendering is on-demand and
    respects `prefers-reduced-motion`. Fit-to-bounds now runs on first load and explicit reset only,
    so filtering or a live tick no longer yanks the viewpoint.
  - **Roads with GPS-style congestion.** Co-references render as flat road ribbons along the street
    graph instead of 1px diagonals through buildings. Road width maps the executions of query families
    naming both endpoints; road colour maps captured wait share graded green/amber/red, upgraded to red
    only where a resolved live lock names that object. Confidence moved to line pattern so colour and
    confidence stay independently readable, and unknown grades stay grey and claim nothing.
  - **Query plan routes.** A plan finder searches query families and plans; picking one draws a
    numbered route through the city (`web/src/cityRoute.ts`) with a turn-by-turn panel. Operators walk
    the tree in post-order and stop at their object's building, the Memory Grant Office, tempdb Works,
    the Storage Depot, or the CPU Scheduler Yard. An object outside the loaded page becomes an explicit
    off-map stop with a reason rather than being dropped, and the panel reports "N of M stops placed on
    this map". The plan's `runtimeOverlayCaveat` is carried verbatim — it is a compiled plan shape,
    never actual operator progress.
  - **CPU, memory, and storage as places.** Six civic facilities (`web/src/cityInfrastructure.ts`,
    `web/src/cityFacilityShells.ts`) render live evidence as architecture: a Scheduler Yard, Memory
    Grant Office, Storage & I/O Depot, tempdb Works, Log Yard, and Lock Authority. Facility shells are
    fixed decoration so a location stays learnable with no evidence; only measured unit heights vary.
    An unsampled subsystem renders as a wireframe with its reason.
  - **Full-bleed map with a floating HUD** — object/plan finders, layer toggles, an encoded-vs-decoration
    legend, compass and camera controls, live-feed pill, and a slide-over for the selected building or
    route. The existing evidence tables are preserved verbatim in a collapsible section below the map as
    the text-first, non-WebGL equivalent.
  - **Every building and facility is named on the map.** A ground label sits on the pavement at the
    frontage each building is entered from — the same kerb point the GPS route stops at, so the label
    and the route agree about where a building's front is (`web/src/cityLabels.ts`). Building labels
    are schema-qualified, which is what a neighborhood tint used to convey. A label carries identity
    and nothing else: it never restates or qualifies a measurement, so footprint, height, roof cap,
    road, and lane keep their documented meanings unchanged. Long names elide from the middle rather
    than the end, because a name's tail is often the only thing separating `orders_2024_q3_archive`
    from `orders_2024_q3_current`. One texture is rasterized per distinct string and reused, so a
    live tick or an appended page redraws labels without churning GPU memory.
- **Waits as traffic to infrastructure.** Query Store wait categories, which were already collected
  but discarded before reaching the city, now flow through `DatabaseCityQueryFamilyV1.WaitMillisecondsByCategory`
  and render as **wait lanes** from a building to the facility whose resource its workload queued for
  (`web/src/cityFacilityTraffic.ts`). Roads answer "which objects are named together"; a lane answers
  "where did the time go", so it is a separate, separately toggleable layer. Lane width maps captured
  wait milliseconds on a documented log₂ scale, lane colour names the destination facility, and lane
  pattern reuses the same attribution-confidence channel roads use. Three refusals are enforced by
  tests rather than left to judgement:
  - A family naming more than one object is **never divided** between them. Query Store reports one
    wait total per query, not per object, so those milliseconds are reported whole in a separate
    "shared" list instead of being split into per-building numbers nobody measured.
  - A category with no counterpart in this city — Parallelism, Network IO, Compilation, Idle — is
    **never folded into the CPU yard**. It is listed with the reason it has no destination.
  - `Buffer Latch` is **not** routed to tempdb Works despite tempdb allocation contention being its
    most famous cause, because the category does not name a database. tempdb therefore has no Query
    Store lane at all.
  A building with no lane is not idle: `sys.query_store_wait_stats` does not exist before SQL Server
  2017 (14.x), so an absent breakdown is stated in prose rather than drawn as a zero-width lane, and
  a lane too wide to draw says so and defers to its exact figure in the evidence table.
- **Lock resource resolution.** `LockResourceParser` parses the engine's verbatim `wait_resource` /
  `resource_description` text into a new optional `LockResourceV1` on `LiveRequestV1` and
  `WaitingTaskV1`. `OBJECT:`/`TAB:` resolve with no lookup; `KEY:`/`HOBT:`/`ALLOCUNIT:` carry only a
  `hobt_id` and are reported `RequiresLookup` until the new bounded `sessions.lock_resource_objects`
  probe resolves them through `sys.partitions` in the owning database; `PAGE:`/`RID:` are reported
  `Unresolvable` because mapping a physical location to an object needs `sys.dm_db_page_info` or an
  allocation scan, and are never guessed; `DATABASE`/`FILE`/`EXTENT`/`APPLICATION`/`METADATA` are
  reported `NotObjectScoped`; an unrecognised prefix stays `Unrecognized`. The field is optional
  throughout, so its absence means the probe did not run, not that no lock is held. The live-cases
  fixture declares a sanitized resolution table so the resolved path is demonstrable offline.

- **Single connection string configuration** for every connected surface. One ordinary ADO.NET
  connection string can now stand in for the ~15 individual connection settings plus a mounted
  password file: `ConnectionStrings:SqlSimCity` (settable as `ConnectionStrings__SqlSimCity`),
  `SQLSIMCITY_CONNECTION_STRING`, or a section-scoped `Atlas:ConnectionString` /
  `LiveIncidents:Connection:ConnectionString`, plus `SQLSIMCITY_EDGE_SQL_CONNECTION_STRING` for the
  edge connector. Supplying one turns connected Atlas and live incidents on by itself, so no mode
  setting is also required; with none configured, fixtures remain the default. The string is parsed
  into exactly the same immutable, fully validated `ConnectionProfile` the field-by-field path
  produces and is then discarded, so every existing guarantee holds — the password is delivered as a
  `SqlCredential` and never concatenated into a connection string, log, or exception;
  `ApplicationIntent=ReadOnly` and the `SQLSimCity` application name are still forced; `Encrypt=false`
  and infinite timeouts are still rejected; and only SQL login, Kerberos, and managed identity are
  accepted (workload identity and service principal need a tenant id a connection string cannot
  carry, and `Active Directory Default` remains banned). The engine platform is inferred from the host
  name (`*.database.windows.net` means Azure SQL Database), Azure SQL `KnownDatabases` defaults to the
  connection string's own database, and explicit configuration always wins over both. This is a
  documented convenience, not the hardened path: an inline password is readable from the process
  environment and cannot be rotated without a restart, so both the API and the connector log a
  warning at startup when one is in use, and mounted secret files remain the production default.
  Neither surface will combine a connection string with any field it already covers, rather than
  letting one silently win — a real safeguard, since `ConnectionStrings__SqlSimCity` is a name some
  hosting platforms inject automatically and would otherwise silently downgrade a hardened profile's
  authentication, TLS trust, and mounted password file. `Max Pool Size` defaults to 20 (the field
  path's ceiling) rather than SqlClient's 100, and `admin:`, `np:`, and `lpc:` data-source prefixes
  are rejected rather than stripped, since the profile is always rebuilt as TCP. The connector's
  prohibition on plaintext secret environment variables is unchanged.
  See `SECURITY.md`, `docs/connected-mode.md`, and `docs/edge-connector.md`.
- Outward-only **edge connector** for monitoring SQL Servers the central container cannot reach
  (`src/SqlSimCity.Edge`, `src/SqlSimCity.Edge.Connector`, `Dockerfile.connector`,
  `compose.edge.yaml`, `docs/edge-connector.md`). A connector near SQL Server connects outward over
  HTTPS, forwards the same source-neutral observations in a versioned envelope
  (`ObservationEnvelopeV1`), signs each request with HMAC-SHA-256 (constant-time verification, bounded
  clock skew, connector allowlist, key rotation, and durable replay-nonce protection), and buffers a
  bounded AES-256-GCM-encrypted spool when the central server is unavailable. Central ingestion is
  opt-in and disabled by default (`Acquisition:Mode=Edge` plus `EdgeIngestion:Enabled`); when enabled it adds one bounded
  `POST /api/v1/edge/ingest` plus read-only `GET /api/v1/edge/status`/`/targets` endpoints, validates
  schema/digest/signature/sequence/epoch/standard-payload contracts with atomic publication, bounded
  idempotency indexes, a dedicated per-client edge rate limit, and compression-bomb guards. One complete,
  allowlisted target generation projects through the existing Atlas, capabilities, Query Store,
  database-city, live, and findings APIs; partial next generations remain invisible. The UI shows a
  compact Edge source/status/target panel and labels live evidence as a static point-in-time sample.
  The connector supports fixture and opt-in connected sources; connected mode composes the production
  SQL collectors over one validated file-secret profile, bounded volatile Query Store storage, and
  text-disabled live probes. No live SQL target was validated; connected tests use fake executors.
- Fixture-mode and opt-in read-only connected server **atlas** (`/api/v1/atlas`,
  `/api/v1/atlas/status`) with a three.js scene backed by a keyboard- and
  screen-reader-accessible database evidence table.
- **Database-city semantic zoom** (`/api/v1/database-city`, `/api/v1/database-city/{databaseId}`)
  with exact page geometry, separated direct-DMV and Query-Store-attributed heat,
  and confidence-graded co-reference routes.
- **Live-incident** point-in-time DMV sampling (`/api/v1/live`) and a
  `/hubs/current-snapshot` SignalR hub, with explicit freshness/staleness and
  never-numeric-zero unavailable states.
- Encrypted, paged **Query Store history** (`/api/v1/query-store/*`) with plan
  history, a hardened Showplan parser (DTD/resolver prohibited, bounded), and
  structural plan comparison from sanitized fixtures.
- Evidence-backed **findings** engine and read-only API (`/api/v1/findings/*`)
  with redacted export.
- Source-neutral SQL Server connection library with SQL/Kerberos/Microsoft Entra
  authentication and file-referenced secrets.
- Optional AES-256-GCM encrypted SQLite record store (disabled by default) with
  fail-closed initialization, key rotation, and bounded retention/pruning.
- Versioned static, read-only SQL probe catalog (`sql/manifest.json` + `sql/probes/*.sql`).
- HTTP hardening: `AllowedHosts` pinning, strict CSP and security headers,
  64-KiB request-body bounds, and per-client API rate limiting that excludes the
  long-lived SignalR hub.
- Container hardening (non-root, dropped capabilities, read-only rootfs,
  `no-new-privileges`, loopback binding), locked dependencies, CI/release
  workflows with SBOM and provenance attestation, Docker fixture smoke, and
  backup/restore tooling with operations documentation.

### Changed

- **Schema neighborhoods are off by default and the layer that draws them is now named for what it
  draws.** The toggle was called "Districts" and started switched on, tinting a translucent plate
  under every schema so the map met you pre-coloured by a grouping that encodes nothing measured.
  Now that each building label carries its schema name, the tint is redundant as well as busy, so it
  starts off and is labelled **Schema neighborhoods**. Nothing about layout changed: buildings sit on
  the same lots, in the same neighborhoods, in the same order. The civic district's own tint moved to
  the infrastructure layer, so it is drawn with the facilities it holds — which both keeps the
  infrastructure district legible when schema neighborhoods are off, and keeps the toggle's name
  literally true rather than quietly also hiding a district that is not a schema.

- **Query Store is now wired into the connected map.** `ConnectedDatabaseCitySource` used to emit
  `topQueryFamilies: []` and `routes: []` against a live server, so on a real connection the city had
  buildings but no workload, no roads, and no wait lanes. A new
  `SqlSimCity.Collection.DatabaseCity.QueryStoreCityAttribution` reads each ranked family's
  normalized compiled plans and resolves their showplan object references against the bounded catalog
  page, producing the families, co-reference routes, per-object attributed exposure, and wait-category
  totals the fixture city already published. The join never guesses: a plan naming several objects
  keeps its totals at query level and is never divided; a reference to a real object outside the
  bounded page is reported by qualified name instead of being dropped; a reference to another database
  becomes a `CrossDatabaseReference` route only when the atlas can resolve that database, and is
  otherwise disclosed by name; a single reference to an indexed view stays `Probable` because the
  optimizer can expand it. An object is credited with a family's totals only when the plans named that
  object and nothing else at all. Wait categories are published only when they reconcile exactly with
  the family's total wait milliseconds, otherwise they are withheld as "not captured" rather than
  shown as a partial account.
- The top query-family table in the database city gained a **Show on map** action that reads the
  family's own plan and draws it as a route through the buildings it names, so ranked workload and the
  3D map are the same evidence rather than two views an operator has to reconnect by hand.
- **Protected storage records are written in the clear, and there is no longer a key at all.** Sealing
  captured plan XML and query text worked against the purpose of a tool whose entire job is to show
  that evidence: it made the store unreadable to the operator who collected it while protecting
  nothing that filesystem permissions did not already have to protect. `EnvelopeCodec` now writes and
  reads a plaintext envelope (format version 2) whose only header is that version byte; `Seal`/`Open`
  became `Wrap`/`Unwrap`. `SECURITY.md`, `docs/connected-mode.md`, `docs/operations.md`, and
  `docs/architecture.md` were corrected, including the removal of the at-rest-encryption claim and the
  addition of an explicit statement that the data volume is the trust boundary.
  Edge spool encryption (`SqlSimCity.Edge.Spool.EncryptedSpool`, separate key, outward-only transport
  threat model) and archive redaction are unaffected, as is `SecureShowplanParser`'s XXE and
  entity-expansion hardening, which is XML safety rather than confidentiality.
- Frontend build is code-split: the three.js atlas/city viewports and the Query
  Store, Live, and Findings tabs load as lazy chunks, and three.js is isolated
  into its own vendor chunk. The initial-path bundle drops from ~848 KiB to
  ~220 KiB and three.js is no longer on the first-paint critical path.
- The Query Store `database_workload_summary` probes now bound the runtime-stats
  interval join by overlap (`end_time > @StartTime AND start_time < @EndTime`),
  matching `runtime_stats_summary` and `wait_stats_summary`, so the atlas
  database-wide totals reconcile with the per-plan drill-down over the same window.

### Removed

- **The protected-storage key ring is gone.** With payloads written in the clear it protected nothing
  and could only cause harm: it regenerated itself on every startup on the connection-string path, and
  on the explicit path a missing key file failed startup outright to guard data that was already
  plaintext. Deleted: `KeyRing`, `KeyRingLoader`, `KeyRingProvisioner`, `KeyRingFileDto`, the
  `ProtectedStorage:KeyFilePath` setting, the `sqlsimcity-keys` directory, the `sqlsimcity-storage-key`
  Compose secret, and `backup-data.sh`'s `--key-file` flag with its exclusion, hard-link refusal, and
  post-archive verification. `KeyRingConfigurationException` became
  `ProtectedStorageConfigurationException`, which is what it always actually reported. The backup
  manifest keeps its `keyIncluded: false` field because `restore-data.sh` matches the manifest line for
  line; it is now a statement about the product rather than about that run.
  Startup still verifies the data directory is writable before committing to it, using a probe file it
  deletes, so a deployment with an unusable mount still degrades to "Query Store history off" instead
  of failing to boot.
- **Support for reading AES-256-GCM (format version 1) records was removed with it.** A store written
  by a version that encrypted payloads now fails its canary check at startup with a message naming the
  fix — stop the app and delete the store directory. Query Store history is a cache the collector
  rebuilds from SQL Server, not a system of record, so the cost is one collection interval.

### Fixed

- `tools/container-smoke.sh` asserted a fail-closed startup message that no longer exists, so the
  `container` CI job failed on the commit that reworded it. The connected Query Store requirement
  message dropped its "plaintext fallback is forbidden" clause when payload sealing was removed —
  that clause had become false — but the smoke test still grepped for it with `--fixed-strings`. It
  now matches the current wording, which is asserted against real captured startup output rather
  than read off the source.

- Three protected-storage log messages and two `Program.cs` comments asserted encryption that had
  already been removed: that query text is encrypted at rest with the generated key, that losing that
  key makes every stored record permanently unrecoverable and the store refuses to open, and that
  query text cannot be persisted without encryption at rest. All were false when written and are gone
  along with the key.

- `LiveIncidentSampler` no longer throws `ObjectDisposedException` when a stop races disposal. The
  disposed check at the top of `StopAsync` is a check-then-act, so a caller could pass it and then be
  preempted before awaiting the control lock that `DisposeAsync` had already disposed. Host shutdown
  makes exactly that interleaving routine, because `IHostedService.StopAsync` and container disposal
  run back to back and `StopAsync(TimeSpan)` can abandon a stop that is still running. The semaphore
  is now left to the GC, which is safe because its `AvailableWaitHandle` is never touched. In CI this
  surfaced as an intermittent "Test Class Cleanup Failure" that failed the build while every
  individual test still reported as passing.
- Rejected edge batches no longer create phantom targets, reserve ownership, mutate partial groups,
  advance generation state, or consume idempotency entries; both accepted-batch indexes now evict
  coherently at a deterministic bound.
- The local Edge Compose example now uses a genuinely loopback HTTP connection by sharing the central
  service network namespace; production delivery remains HTTPS-only.
- Both runtime images now declare the repository's Apache-2.0 license and contain `LICENSE`/`NOTICE`.
- A rejected lazy-chunk import no longer unmounts the application: every lazy
  surface is wrapped in an error boundary that renders a focused, announced
  alert with a reload action.
- Connected live-incident sampling no longer fails on every cycle. The transaction-log probe
  emits exact `total_log_size_bytes`/`used_log_space_bytes`, but the live-incident executor read
  `total_log_size_mb`/`used_log_space_mb`, so every sample threw `IndexOutOfRangeException` against
  a real server. It now reads the byte columns and converts to the megabytes the contract, findings
  rule, and UI all expect. This was invisible to the unit tests, which substitute a fake probe
  executor for the real `SqlDataReader` path, so a corpus-wide guard now asserts that every column
  the Atlas and live-incident executors read by name is actually emitted somewhere in the probe SQL.
- Connected live-incident sampling no longer fails on every cycle **against Azure SQL Database**.
  `SERVERPROPERTY('IsHadrEnabled')` is documented "Applies to: SQL Server", and SERVERPROPERTY
  returns NULL for any property unsupported on the connected engine, so the server-identity probe
  returned NULL there and the unguarded `Convert.ToInt32` threw
  `InvalidCastException: Object cannot be cast from DBNull to other types` on every sample. Azure
  SQL Database and Managed Instance now read as "not enabled", which is what the value means on a
  platform whose high availability is built in rather than configured as an availability group.
  The same unguarded read was present in the edge connector's probe executor and is fixed with the
  shared helper.
- A single unreadable column no longer costs an entire live-incident cycle. `LiveIncidentCollector`
  is designed to degrade — it records an `UnavailableFieldV1` and publishes the rest of the
  snapshot — but only recognized `ProbeExecutionException`s, so a row-projection failure escaped to
  the sampler and destroyed every other subsystem's evidence for that cycle. Row-shape failures are
  now classified as the already-defined `ProbeDataFormatException`, so an unexpected NULL or missing
  column on any engine edition degrades exactly one field, names itself in
  `diagnostics.unavailableFields`, and leaves the rest of the snapshot intact. Genuine programming
  faults are deliberately still allowed to propagate.
- Connected Query Store history now collects. `SqlQueryStoreIncrementalSource` issued every probe
  with `CommandBehavior.SequentialAccess`, which permits each column to be read once and only in
  ascending ordinal order, while all nine of its projectors read columns by name in whatever order
  the record needs. Database discovery read `is_query_store_on` (ordinal 8) before `database_name`
  (ordinal 1), so the very first step of every cycle threw
  `InvalidOperationException: Invalid attempt to read from column ordinal '1'` and connected Query
  Store history had never collected a single row against a real server. Nothing in that file uses a
  streaming accessor, so sequential access bought no memory saving and only made by-name projection
  illegal; it now uses the default behavior, matching the Atlas, live-incident, and connector
  executors. A corpus-wide guard asserts no probe reader combines by-name column access with
  `SequentialAccess`.
- Supplying a connection string no longer produces query views that are emptier than the sample
  data. Connected Query Store history requires encryption at rest and has no plaintext fallback, but
  a connection string enabled Atlas and live incidents while leaving Query Store history on
  `UnavailableQueryStoreHistorySource`, so pointing SQLSimCity at a real server silently downgraded
  the query views to nothing at all — with no error and no log line. A connection string now enables
  connected Query Store history and provisions the required AES-256 key, so the encryption
  requirement is met rather than relaxed.
- The Findings page no longer returns 500 for an ordinary large execution plan.
  `SecureShowplanParser` counted *every* XML element against `MaximumNodes`, a limit meant to bound
  the operator tree it retains, and threw `Showplan exceeds the 20000-node limit`. Only `RelOp`
  elements are ever retained, but a real plan carries thousands of `ColumnReference`,
  `ScalarOperator`, and `DefinedValue` elements per operator, so a normal plan tripped a DoS guard
  at roughly a hundred operators. The operator cap now counts operators, a separate, far larger
  `MaximumElements` cap bounds total streamed elements, and — because raising that cap would
  otherwise have raised what a single crafted operator can make the parser retain twentyfold — the
  two per-operator lists that grow without a bound of their own, expressions and warnings, now state
  their own caps instead of inheriting one as a side effect of the element counter. The accumulated
  text buffer, which nothing ever read, was replaced by a running character count, and
  `MaximumTextCharacters` was raised to 4 MiB because it is only a size check against text a plan of
  the permitted size can legitimately exceed.
- One unparseable plan no longer destroys the entire findings evaluation. `SourceBackedFindingsEvidenceProvider`
  let an `XmlException` from any single plan escape `LoadPlansAsync`, so `/api/v1/findings` and
  `/api/v1/findings/status` both returned an unhandled 500 and the page showed nothing at all rather
  than the findings it could still prove. Plans that cannot be normalized are now skipped and named
  in the bundle reason, so Showplan-backed rules evaluate on what parsed and the exclusion is
  disclosed instead of hidden. `/api/v1/queries/plans/{planId}` and `/plans/compare` likewise return
  422 with the reason instead of an unhandled 500.
- Roads are no longer drawn severed. The dashed and sparse confidence patterns were rendered by
  trimming each *whole polyline leg* to a fraction of its length and centring the remainder, but a
  street-grid road has only two to four long legs, so instead of dashes every non-confirmed road
  showed one enormous gap per leg and read as broken. Patterns are now real repeating dashes of a
  fixed world length whose phase carries across corners, so a road reads as one route and the
  pattern means the same thing on a long road as on a short one. Query Store **wait lanes** carried
  the identical defect, because they encode confidence through the same channel; they now share the
  same dash geometry and sit above every road lane so a lane and a road on one street stay distinct.
- Roads that share a street no longer hide each other. Every road was drawn on the street centre
  line at the same height, so overlapping roads z-fought and only the last one drawn was visible.
  Roads now claim the lowest lane free on every leg they use — widest first, so the heaviest traffic
  keeps the centre line — and are stacked a hair apart, making a busy corridor read as the several
  distinct references it is.
- A road can now be identified. Roads were not pickable and were never labelled, so the one thing
  the map claims about a road — which two objects it connects — could not be read off it. Roads are
  now hoverable and clickable, naming both endpoints in a readout and in a road panel that gives the
  reference kind, confidence, executions, wait share, congestion grade, and the rationale behind
  each, with links to either endpoint building and a Frame road control. The "Evidence-labeled
  routes" table now prints schema-qualified object names instead of raw stable ids, selects the road
  on the map, and says so when a route is not drawn because an endpoint is outside the loaded page.
- The Query Store query detail panel can now be closed. Opening a query family replaced the panel
  but nothing ever cleared it, so the only way out was a page reload. It now has a Close control,
  responds to Escape from anywhere on the page, returns focus to the page heading rather than
  stranding it on a removed button, and the family row that produced it is marked selected.
- A right-drag on the database city map no longer permanently disables map hover. The pointer-down
  gesture was only cleared on a primary-button pointer-up, so panning with the right button left it
  latched open.
- A closed Query Store detail panel no longer re-opens itself. The family fetch was tracked only for
  unmount and metric changes, so closing the panel — or clicking a second family — left the first
  request in flight, and its `setDetail` reinstated the panel when it landed. The detail request is
  now aborted by both a close and a newer selection, so only the latest one can win.
- Closing the database city road panel no longer strands keyboard focus. Its Close and endpoint
  buttons unmount the panel they live in, which dropped focus to `document.body` and restarted the
  next Tab at the top of the page. Focus now returns to whatever opened the panel, falling back to
  the city heading, and Escape closes the panel the way it closes the Query Store detail.

### Security

- **Superseded within this same unreleased block:** the three protected-storage entries immediately
  below describe key custody as it was when payloads were sealed. Payloads are now written in the
  clear and the key ring has been removed entirely (see Changed and Removed), so none of the key
  custody, rotation, or backup-exclusion guidance below applies. The data volume's access control is
  the trust boundary.
- A connection string now auto-provisions the protected-storage AES-256 key that connected Query
  Store history requires, in a `sqlsimcity-keys` directory inside the data directory. Encryption at
  rest is unchanged and still mandatory; what changes is that the process generates the key instead
  of an operator supplying it, so key custody is weaker than the hardened path. It is placed inside
  the data directory deliberately, so the key is exactly as durable as the data it protects: in a
  container every other location is either unwritable or ephemeral, and a key destroyed while its
  data survives leaves every protected record permanently unopenable. The trade-off is that a raw
  volume snapshot contains both. It is written `0600`, never overwrites an existing key, and is
  announced at startup with a warning naming the path. The hardened path is untouched: setting
  `ProtectedStorage:Enabled=true`, or configuring the connection field by field, still means
  operator-supplied key custody and still fails closed without a key. Auto-provisioning never
  happens in archive or edge mode, and never overwrites a mounted key.
- `tools/backup-data.sh` now excludes the storage key from the archive instead of refusing to run
  when the key resolves inside the data directory, and verifies the key is genuinely absent before
  writing the backup. The guarantee that no backup carries its own decryption key is preserved;
  what changes is that deployments using an auto-provisioned key can be backed up at all. A hard
  link to the key inside the data directory is still refused, because it cannot be excluded by path.
  **A backup therefore cannot restore a protected store on its own — the key must be kept
  separately.**
- A key that cannot be written no longer takes the process down. Where the data directory is not
  writable, connected Query Store history disables itself with a warning explaining the cause and
  the fix, preserving the previous startup behavior instead of turning a convenience into an outage.
- A persistent, color-independent trusted-network / no-built-in-login notice is
  now shown on every analysis view, including on mobile, reinforcing the
  documented `AllowedHosts` and reverse-proxy guidance.

### Known limitations

- **Live SQL Server validation is partial.** Connected Atlas collection, live-incident sampling, and
  connected Query Store history have now been exercised end to end against a real local SQL Server
  (Kerberos/integrated auth), which is what surfaced the transaction-log column defect and the
  `SequentialAccess` defect above. Query Store history was confirmed collecting real queries with
  real runtime metrics from a live database. The Azure SQL Database
  `IsHadrEnabled` defect above was reported from a real Azure SQL Database and was reproduced and
  verified locally by making the identity probe emit NULL for that column, but no Azure SQL Database
  or Managed Instance target was available for direct end-to-end confirmation, so platform-specific
  behavior on those, and every Entra authentication strategy, remains otherwise exercised only
  against fakes and deterministic fixtures. Query Store collection past database discovery has been
  observed only against a single local server, so engine-version-specific projectors (the 2016/2022
  variant and 2025 replica paths in particular) are still unproven on the editions that select them.
- GHCR image publication, SBOM, and provenance attestation are defined in the
  release workflow but are not executed as part of this candidate; their outputs
  are unverified until a tagged release runs.
- Behind a reverse proxy, forwarded-header processing is intentionally disabled,
  so API rate-limit partitioning collapses all clients into one bucket. This is
  correct for the documented loopback/trusted-network model.
