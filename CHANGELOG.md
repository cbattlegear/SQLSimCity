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

- **The traffic map, and waits placed on the tables that caused them.** The map's default road layer
  used to be one ribbon per pair of co-referenced tables — the join graph, not the traffic — and
  selecting a plan drew a route that detoured through the six civic facilities, so a query appeared to
  drive to the CPU Scheduler Yard and back between reading two tables. Neither matched what a query
  actually does. Three changes:

  1. **Routes stop only at tables.** Operators that name no object fold onto the heaviest table in
     their own subtree; operators reaching no on-page table at all are listed separately as unplaced
     rather than attached to a nearby building. Each stop lists the operators that happen there and,
     per operator, the resource it leans on — so the facility classification survives as a *property
     of the operation* instead of a destination on the route.
  2. **Waits are attributed to tables by estimated plan cost.** A family's measured wait total is
     apportioned across the tables its plans read, in proportion to each table's share of the plan's
     estimated cost (`PlanCostAttribution`, `WaitApportionment`, mirrored for the browser in
     `web/src/planCost.ts`). The apportionment is exact — fixed point at 1e9 with largest-remainder
     allocation — so the parts and the remainder reconstruct the measured total byte-for-byte.
  3. **The default map layer is aggregate street load.** Every ranked family is driven through its
     tables and each street accumulates the executions and apportioned wait of the families crossing
     it. Per-query ribbons move to an opt-in `paths` layer.

  **This does not weaken the rule above.** `attributedExposure` and `sharedExposure` are untouched and
  keep their exact previous meaning: Query Store totals are still never divided, because Query Store
  says nothing about which table caused what. The estimated *plan* does — every `RelOp` carries
  `EstimateCPU`, `EstimateIO` and an object reference — so this is a third, separate evidence class
  built on a different source, living in its own contract field, its own UI section and its own legend
  paragraph, each stating *modelled, not measured*. Cost the plan spent off-page, cross-database or on
  pure computation is never handed to a building; it is reported as unplaced. Summing a building's
  estimated wait with its attributed exposure is meaningless, and nothing in the UI invites it.

  Traffic is shown as **two channels, not one number**: width is executions, colour is apportioned
  wait milliseconds per execution. A count and a duration have no common unit, and blending them into
  a single "traffic level" would require inventing an exchange rate between an execution and a
  millisecond.

- **Shared Query Store exposure** ([#40]). The strict attribution rule is unchanged — an object is
  credited with totals only when a ranked family names it and nothing else — but on a normalized
  schema that condition is close to unreachable, so a join-heavy database rendered with no exposure
  anywhere and every building `Unavailable`. Families that name an object *alongside others* now
  contribute a separate `DatabaseCitySharedExposureV1`, carrying the query-level totals **whole** on
  every object the query named, with a rationale in the payload stating they must not be summed
  across buildings.

  Totals are deliberately **not** divided between the named objects. Query Store measures one figure
  per query and says nothing about which table caused what, so any per-object share would be
  invented. The map draws shared exposure as an *outlined* roof cap against the solid one used for
  attributed exposure, matching the wireframe-means-not-measured convention already used for unknown
  index annexes and unsampled facilities.

  `BuildExposure` now emits an entry for every on-page object any ranked family named, which fixes a
  third bug by construction: an object named only by multi-object families previously fell through
  both the sole and shared buckets and hit the connected source's "no ranked family names this object"
  fallback, which was false. That fallback now fires only when it is literally true.

- The offline fixture gained `dbo.OrderDetail`, a child table every ranked plan reaches through a
  join. It has null attributed totals and non-null shared totals, so the shape that motivated the
  change above is visible in the shipped demo rather than only asserted in a test.

- **The map is the product now.** SQLSimCity opened as a document: the 3D city was one box in a
  scrolling page, below a masthead and four tabs, between status banners, evidence tables, and prose.
  The UI is now a full-bleed map with a sidebar over it, and every control floats on the canvas.
  There is no tab bar and no page that is not the map.
- **The Query Store address book.** The sidebar is one flat, searchable list of query families,
  tables, and infrastructure facilities together, each with a measured one-line summary and an
  address derived from the city plan (`dbo · Block C4`). One search box matches all three kinds
  across name, schema, query hash, and the objects a query visits — so searching a table name also
  surfaces the query families that drive traffic to it. Selecting an entry selects it on the map and
  pushes a place card over the list, built from the existing evidence panels so no wording is lost.
  An object that is not on the loaded bounded page has no lot, and the entry says so instead of
  inventing a location.
- **A flat map view, toggled against the 3D city view.** Map mode narrows the camera to a 13° field
  of view with the polar angle locked flat, switches to a single ambient light so materials read as
  their flat base colour, collapses buildings to footprint plates, draws roads as white fill over a
  grey casing, and replaces facility geometry with teardrop POI pins. It is one scene, one raycaster,
  and one set of controls in both modes, so anything selectable in 3D is selectable on the map.
  Road colour deliberately survives the switch, because congestion colour is measured evidence rather
  than styling.
- **Live incidents are pinned to the building they were measured on.** A blocked waiter, or a session
  caught in a cycle in the current wait graph, gets a pin on the lot whose lock it is waiting on, with
  an HTML popup naming the wait, the blocker, the resolved lock resource, the source DMV, and the
  observation time. The evidence rule holds throughout: a snapshot that never carried a lock resource
  is reported as *not observed* rather than as no blocking; a lock resolving to an object outside the
  loaded page is counted as off-map rather than pinned to the nearest lot; a lock that names no object
  is listed with the parser's own reason; and a cycle in the current wait graph is reported as exactly
  that, because SQL Server resolves real deadlocks before they can be sampled.

- **`ReverseProxy` restores per-client API rate limiting behind a proxy.** The rate limiter partitions
  on the connection's remote address, so behind a reverse proxy every caller previously collapsed into
  one shared 600-per-60s bucket and one noisy client could exhaust it for everyone. Setting
  `ReverseProxy__Enabled=true` together with `ReverseProxy__KnownProxies` (exact peers) or
  `ReverseProxy__KnownNetworks` (CIDR blocks) honours `X-Forwarded-For` and `X-Forwarded-Proto` from
  those peers only, giving each client its own bucket again; both accept semicolon- or
  comma-separated values. Off by default, so the shipped pipeline is unchanged. Enabling it without
  naming a peer **stops startup**: `X-Forwarded-For` is client-supplied text, and an unrestricted
  allowlist would let anyone reaching the port claim an address and take a private bucket per request,
  which is worse than the shared bucket the setting fixes. A request carrying `X-Forwarded-For` from an
  unlisted peer has the header ignored and logs `ForwardedHeadersFromUntrustedPeer` once naming the
  address seen, because an ignored header otherwise looks exactly like a working deployment.
  `X-Forwarded-Host` is never honoured — `AllowedHosts` filters on the request host, and a header must
  not rewrite the value that check reads. Once enabled, recorded client addresses are asserted by the
  proxy rather than observed by this process. See
  [`docs/operations.md`](docs/operations.md#forwarded-client-addresses).
- **`Deployment__AcknowledgeSecurityWarnings` hides the browser security banner.** The UI states on
  every page that SQLSimCity has no login of its own, which is worth saying once but dominates a demo
  or a screen recording. Setting `Deployment__AcknowledgeSecurityWarnings=true`, or the unprefixed
  `SQLSIMCITY_ACKNOWLEDGE_SECURITY_WARNINGS=true`, hides that banner. It is a display decision and
  nothing more: no authentication appears, no host binding relaxes, and the startup warnings the API
  writes to its own log — an inline connection string, or query text and plan XML retained in the
  clear — are deliberately left at warning level and are **not** suppressed, so the log becomes the
  durable record once the screen stops carrying it. Served from a new `GET /api/v1/deployment`, so it
  takes effect on container restart with no image rebuild. It fails toward disclosure at every step:
  the default shows the banner, an unreachable or malformed response shows the banner, and a value
  that is neither affirmative nor negative stops startup with a named error rather than being guessed
  at — a typo can never quietly suppress a security fact.

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
    and the route agree about where a building's front is (`web/src/cityLabels.ts`). A label carries
    identity and nothing else: it never restates or qualifies a measurement, so footprint, height, roof
    cap, road, and lane keep their documented meanings unchanged. Long names elide from the middle
    rather than the end, because a name's tail is often the only thing separating `orders_2024_q3_archive`
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

- **A query route takes over the sidebar instead of sharing it.** Clicking a query in the address
  book used to leave the query list in place and pin the route to a 46vh card below it, and the panel
  carried both a `Clear` button and a `Back` button whose difference was never explained by anything
  on screen. Now opening a route collapses the address book, the route card fills the rail
  (`.sidebar-place-card.is-full`), and the header takes the route's identity: the title becomes
  *This query's route*, the subtitle names the plan and how many of its tables were placed, and the
  one remaining back button returns to the database — which restores the list, the drawers and the
  header exactly as they were. Leaving the database is then a second, separate press, which is what
  makes the two destinations distinguishable. Measured at 1115x800 the route card grows 103px -> 698px
  with zero unreachable pixels and scrolls inside itself; at 820px the sheet keeps it content-sized.
  The decision lives in `web/src/sidebarMode.ts` so it is unit-testable without a DOM.

- **Buildings are scattered by a seed rather than packed into a rectangle.** `web/src/citySeed.ts`
  adds a small seeded generator, and the seed is a stable hash of the database's own id, so a city
  looks like a city while laying out identically on every load, in every browser, on every machine —
  nothing here touches `Math.random()`. Two invariants make that safe: the grid is sized from
  `page.totalObjects` rather than the loaded count, and each object's slot is derived from the
  backend's per-schema ordinals plus the complete schema list every page carries, so **appending a
  page never moves a building that is already on screen**. Filtering the address book no longer
  rearranges the city either.
- **Infrastructure is distributed across the map.** The reserved civic rectangle is gone. The six
  facilities are placed first, each accepted only when it is at least two blocks (Chebyshev) from
  every already-placed facility. On a grid too small to satisfy that, a deterministic
  maximise-minimum-distance sweep takes over, so a four-table database still lays out — tighter, and
  still fully determined by the seed.

- **System databases are excluded from Query Store evidence.** `master`, `tempdb`, `model`, and
  `msdb` were collected like user databases, which produced noise in three places at once: a Query
  Store options probe that failed or reported `OFF`, an atlas cycle counted as **degraded** because
  of that failed component, and a `query-store-health` finding announcing an evidence gap in a
  database that is not a workload evidence source to begin with. Query Store cannot be enabled on
  `master` or `tempdb` at all, and the engine's own maintenance workload in `msdb` or the `model`
  template is not application evidence. Those four names are now excluded at every stage: the
  incremental collector drops them from both discovery and an explicit `Atlas__KnownDatabases` list
  (an explicit list naming only system databases now collects nothing rather than silently falling
  back to discovery), the connected atlas records their Query Store as `Unsupported` with the
  exclusion as its stated reason instead of probing it, that record counts as neither a failure nor
  a skip so it can never degrade a cycle, and `query-store-health` skips them by name. They remain
  in the atlas with their capacity, live activity, and file-I/O evidence — only the Query Store
  surface is withdrawn, and it says so rather than reading as a missing measurement.

- **Building labels are larger and are never hidden by the city.** At the default framing most table
  labels were unreadable: they rasterized small and, being depth-tested, were drawn behind the very
  buildings they named. Labels now ignore the depth buffer entirely (`depthTest: false`, render order
  above every other pass in the scene) and `LABEL_WORLD_HEIGHT` rises from `3.6` to `6.2`. Measured
  on the sales fixture at the reset view: all 10 labels resolve as distinct on-screen boxes with
  **zero overlapping pairs**, and glyph bands grow from roughly 9-12px to 15-20px. `LABEL_MAX_CHARS`
  drops from `32` to `24` to hold plate width in check, since width scales with the new height and a
  long name would otherwise span several lots; the elision is still from the middle, so both ends of
  a name survive, and the full name remains in the evidence tables and detail panel. The tradeoff is
  disclosed rather than hidden: a label drawn in front can overlap geometry it does not name, so the
  "what encodes evidence" note now states that a label names only the building at its own anchor.

- **Multi-object query plans are drawn instead of footnoted.** A query family naming more than one
  object used to be dropped from the wait layer entirely: its milliseconds went into a text-only
  "shared" bucket and nothing reached the map. The refusal was sound — Query Store measures one wait
  total per query, not per object, so splitting it fabricates a per-building number, and handing it
  whole to whichever named object happened to be loaded is worse still — but the conclusion was
  wrong. Showing a *relationship* needs no division at all. Such a family now draws a **shared lane**
  (`SharedFacilityLane` in `web/src/cityFacilityTraffic.ts`): one lane per family and facility, its
  path threaded through every named object on the page before running out to the facility, carrying
  the family's whole captured wait **exactly once**. Because it is drawn once and kept out of
  `FacilityTraffic.lanes`, nothing is divided and nothing is double-counted; per-object totals still
  contain only the families that measured that object alone. A shared lane sits above exclusive lanes
  so overlaps stay readable, and its own row in the evidence table names the buildings it threads,
  states that the figure belongs to none of them individually, and discloses how many named objects
  are off the page and therefore missing from the drawn path. Only a family with *nothing* on this
  page — leaving no honest path to draw — still falls back to text.
- **Per-object exposure now says where the multi-object work went.** The attributed-exposure
  rationale in `QueryStoreCityAttribution.cs` read "multi-object plans are excluded rather than
  divided", which stated a true policy but implied the evidence was discarded. It now counts the
  ranked families that name the object alongside others and points at the routes and shared lanes
  that carry them whole. The scalar totals themselves are unchanged: still only families that named
  the object and nothing else, still never divided by an invented ratio.

- **Every building stands alone on its own block.** A block used to hold eight buildings in two
  back-to-back rows, which read as an undifferentiated mass of geometry, so the separation moved into
  the street lattice itself: `BLOCK_COLS`/`BLOCK_ROWS` in `web/src/cityPlan.ts` are now `1`, giving
  each object a lot ringed by street on every side. Which lot inside a neighbourhood a building takes
  is still derived purely from the backend's stable layout ordinals and encodes nothing — adjacent
  buildings within a schema are not related by being adjacent, and the map's own prose says so.
  The change costs roughly 1.7x the ground area per building, paid deliberately for separation that
  does not depend on a layer being switched on. Because the reserved civic rectangle is measured in
  blocks, it was resized from 3x2 to 5x3 so the six infrastructure facilities keep the footprint they
  had before rather than shrinking to the size of the tables they serve. Routing cost was measured
  rather than assumed: 30 street paths across a 500-object city (672 intersections) take ~8.5 ms.

- **Schemas are neighbourhoods again, and this time the map means it.** The three earlier attempts at
  this — a translucent district plate, then a schema-qualified label, then a toggle that started off —
  all tried to state schema membership *on top of* a layout that scattered a schema's tables across the
  whole grid. `planNeighborhoods` in `web/src/cityPlan.ts` replaces the global shuffle with a seeded
  multi-source region-growing partition: farthest-point-sampled seeds, round-robin growth so no schema
  is walled in by a neighbour that grew first, and a per-block seeded wobble so edges come out ragged
  rather than rectangular. A schema's tables now stand on contiguous ground, so you can find one by
  walking to it. Territory shape is a function of the seed, the grid, and the **full** schema counts
  every page carries — never of which objects have loaded — so appending a page still never moves a
  building that is already on screen.
  - **The cue is colour that survives the light.** `tintPreservingLuma` in `web/src/cityBuildings.ts`
    mixes a per-schema hue into a facade and then rescales the result back to the facade's original
    luminance. A plain blend strong enough to see under golden-hour light also drags every building
    toward one lightness and flattens the massing that makes the city readable; taking hue from the
    mix and brightness from the building removes that trade, so the tint can be pushed to a weight
    that actually reads. Map mode carries the same hue through `mapBuildingColor` rather than
    flattening every plate to one grey. `vacant` lots are never tinted — an unmeasured parcel does
    not belong to a schema.
  - **The label moved up a level.** Building labels are now the bare object name; the schema is
    written once, large, across the middle of its own territory, sized to the ground it covers. What
    used to be repeated on every rooftop is now said once by the map itself.
  - **The toggle is gone**, along with the heading and legend strip that used to track it. There is
    no longer a state in which the map draws a grouping it does not explain, or explains one it does
    not draw. The schema strip in the legend is always shown, each name beside its own colour swatch.
  - **What this costs in honesty, stated plainly.** Position now *does* encode something: which
    schema an object belongs to, a catalogue fact you can verify with a query. The legend and
    `docs/architecture.md` were rewritten to say so, replacing the older claim that "where things
    stand encodes nothing". Territory *area* is proportional to object count, so it weakly encodes a
    count too — both documents now direct you to read the counts beside each name rather than
    estimate from the area. Which lot inside a neighbourhood, and which neighbourhood sits next to
    which, remain arbitrary.

- **The streets are traced now, not laid out.** The previous pass moved the junctions off the lattice
  and the result was still, in the end, a wiggly grid: displacing `col * pitch, row * pitch` gives you
  a deformed lattice, and a deformed lattice is a lattice. So the street plan is no longer authored at
  all. Five new modules generate it and the blocks are whatever the streets happen to enclose.

  - **A tensor field decides which way the streets run** (`web/src/cityField.ts`). A tensor rather
    than a vector because a tensor carries two perpendicular directions at once, so tracing one family
    along the first and the cross streets along the second makes them meet at right angles everywhere
    while both curve freely — orthogonality is a property of the mathematics rather than a rule
    anything has to enforce. The field is a sum of overlapping district grains, each with its own
    bearing and extent, plus a term that turns streets to run along the river instead of into it.

  - **Streets are traced through it and stop when they meet each other**
    (`web/src/cityStreamlines.ts`), integrating with RK4 and growing outward from what already exists.
    That single stopping rule is what produces the look: streets end where they run into other
    streets, in T-junctions, without anything having decided to make a T-junction.

  - **Blocks are recovered, not allocated** (`web/src/cityGraph.ts`, `web/src/cityBlocks.ts`). The
    traced curves are split at their crossings, welded, snapped and trimmed into a planar graph, and
    the city blocks are its faces — every one a different shape and size because the streets around it
    are. A share of the crossroads is then broken down into pairs of T-junctions, because two
    orthogonal families produce more four-way junctions than a real city has.

  There is deliberately **no ring road, no radial spokes and no centre** in the field, after three
  attempts at one all failed and each looked right in the code. A radial element gives a dozen
  concentric rings converging on a point, so the most ordered part of the map is exactly where a real
  city is most tangled. Adding noise turns those rings into a *spiral*, because a street tracing a
  ring comes back round one street's width inside where it began and carries on — and nothing objects,
  since each arm of the spiral is a legal distance from the last. Peaking the element on a circle
  removes the whirlpool but leaves four or five concentric rings on the ring line, because a field
  cannot say "exactly one ring road": it gives a direction everywhere and the tracer fills the space
  with streets parallel to it. The large scale is now left to emerge from overlapping district grains,
  and the city gets a legible skeleton and a centre without either having been drawn. District grain
  scales with distance from the middle, so the core is a mosaic of small parcels and the outskirts are
  single large plans.

  A fourth failure was subtler and only appeared on the biggest instances: a district's extent was a
  fraction of the *city* radius, so as a database grew the districts grew with it and the grain
  coarsened until a district was, in effect, a city-wide element again. Extent now comes from the
  spacing the districts actually have, which holds the grain constant from a hundred tables to six
  thousand. The general lesson is worth keeping: anything sized as a fraction of the city radius
  eventually becomes a city-wide element.

  Tracing can also strand a pocket of streets with no way in, where one quarter's grain turns hard
  against its neighbour's and the seam opens wider than the radius that snaps loose ends together.
  That fault is invisible — the pocket draws perfectly, blocks and all — and shows up only as a query
  ribbon that never appears, which looks exactly like a query that was never run. Each island is now
  joined across its closest approach, after the faces are walked so the blocks still come from a
  strictly planar graph.

  Measured against Boeing's survey of 27,000 real networks — 23.4% four-way, 14.5% dead ends, mean
  degree 2.7–3.0 — the traced city holds 23.7–25.6% four-way, 13–20% dead ends and mean degree
  2.73–2.83, at every size, and every sample journey routes.

  Two sizing faults made a large database slow to open, and both were arithmetic rather than
  algorithm. The city's radius was set at 1.75·√objects separations, which sounds like a modest
  margin but is not: a traced block covers about 1.34 separations squared, so the ground grows as
  the *square* of that constant and the map came out with nine blocks for every building — four
  fifths empty, and four times the streets to trace, weld, classify and grow neighbourhoods across
  for ground nothing would ever stand on. At 1.0 it is a little over two blocks per building, which
  still leaves the facilities, the water and the gaps between neighbourhoods their room. Separately,
  the gap sweep that fills the parts of a radial field propagation cannot reach was rasterising the
  entire plan on every pass and never converging, so it always ran its full six passes per family
  and paid the full price for each. Coverage only ever grows, so the candidate grid is now laid out
  once and whittled down. Together these take planning a 2400-table city from **9.9 s to 1.3 s**,
  with every street, lot and neighbourhood bit-for-bit unchanged by the sweep half of it.

  Denser neighbourhoods then exposed a bug in their own labels. The name was written at the mean of
  the blocks a schema owns, with a comment explaining why the *bounding box* centre would not do —
  an L-shaped territory does not contain it. The mean has exactly the same flaw for a crescent,
  whose middle is the bay. The label is now pulled to the owned block nearest that mean, which lies
  on the neighbourhood by construction whatever shape it grew into.

- **Query routes are driven now, not walked.** Roads gained a real hierarchy, speed limits, and
  satnav-style routing, and the workload decides where the traffic goes.

  - **Road class is measured on the network rather than asserted** (`web/src/cityRouting.ts`). Edge
    betweenness — the share of shortest routes between all pairs of junctions that use each street —
    finds the roads everything has to pass through, which is the definition of an arterial. Classes
    are assigned by *rank*, not by score against the busiest street: a city of overlapping grains has
    many roughly equal cross-town routes rather than one clear peak, and scoring promoted a third of
    the network. Fixing the proportions instead makes the ladder read on a six-table database and a
    six-thousand-table one alike, and is the honest reading of what betweenness measures — a ranking,
    not an absolute. Class sets a speed limit and a carriageway width.

  - **Routing is A\* over travel time with turn penalties.** States sit on *directed* edges rather
    than junctions, which is the only way to charge for a turn at all: at a junction you have no idea
    which way the journey arrived, so there is nothing to compare the departure against. Turn
    penalties stop a route zig-zagging block by block toward its destination, and following a bend
    costs nothing because headings are read from the vertices either side of the junction.

  - **The measured workload loads the network** (`web/src/cityAssignment.ts`). Each ranked query
    family contributes trips between the objects it named, in proportion to its measured execution
    count, and those trips are assigned incrementally: route a journey, add its traffic, recost the
    streets it filled with the standard BPR congestion curve, route the next. Busy corridors slow as
    they fill and later journeys find their own way round, so two heavy families between the same pair
    of buildings are drawn on different roads instead of on top of each other. Trips are normalised to
    a unit total first, so how congested the map looks reflects the *shape* of the workload rather
    than how busy the server happened to be.

  **No measured quantity changed.** Footprint, height, archetype, road width, dash, and facility slot
  fill are byte-identical, and street geometry and road class remain a pure function of the
  database-id seed, so the same database still draws the same city. The demand is measured and used
  verbatim; the route it takes is not evidence, and the legend's "The street plan is drawn too" block
  now names road class, speed limit, block shape and congestion alongside the rest.

- **The street plan is a city now, not a wiggled grid.** Streets had been given curves and a class
  hierarchy, but every junction still sat at `col * pitch, row * pitch`, so the map still read as
  graph paper with bent lines on it. Bending a road between two lattice points leaves two lattice
  points, and junctions are what the eye reads a street plan by. Two things changed.

  - **The junctions actually move.** A new `web/src/cityWarp.ts` owns the `(col, row) → world`
    mapping and displaces it in four layers: spans that vary block to block, a smooth meander that
    bends whole runs of street together, a per-district rotation that fades to zero at the arterial
    seams so arterials stay continuous, and a pull toward each public square. Every block is now its
    own quadrilateral at its own angle, and the land cover, neighbourhood washes, terrain and
    addresses are all rebuilt from that mapping instead of from a pitch — division no longer inverts
    it, so `warp.nearestNode` and `warp.blockAt` do the inverse by search. The deformation budget is
    guaranteed rather than hoped for: `fitDisplacement` checks every block's inradius against the
    building it has to hold and halves the displacement until it fits, and a test asserts it never
    has to, across twenty seed-and-size combinations, so the safety net cannot quietly flatten a city
    back toward a grid without failing the build.

  - **The junction *degrees* changed, which mattered more.** Boeing's survey of 27,000 street
    networks puts a real city at roughly 57% T-junctions, 14.5% dead ends and 23% four-way crossings
    with a mean node degree of 2.7–3.0; a lattice is 100% four-way at 4.0. `pruneJunctions` removes
    segments toward those targets and refuses any removal that would disconnect the graph, strand a
    block with no street to front on, or break an arterial. Measured from 24 to 700 buildings it
    holds mean degree 2.5–2.7, dead ends 13.5–14.3% and four-way crossings 10–19%, and the test suite
    asserts that range so the pass cannot silently become a no-op.

  Around those: arterials now run at irregular gaps of three to seven blocks instead of a fixed
  rhythm, squares open where interior arterials cross, avenues radiate into them, and the interior
  pattern vocabulary went from five to seven with `radial` and `organic` added and the weighting made
  radial — so `downtown`, the one pattern that keeps a full fine grid, is confined to the middle of
  town and is never the default. Because a bowed street's carriageway is nowhere near the
  straight-line midpoint of its junctions, `rebindFrontages` snaps every building's access point onto
  the nearest point of a drawn path, so doors land on the road you can see.

  **No measured quantity changed.** Footprint, height, archetype, road width, dash, and facility
  slot fill are byte-identical, the city is still a pure function of the database-id seed, and the
  legend gained a second disclaimer — "The street plan is drawn too" — naming block size, junction
  shape, dead ends, squares and arterial rhythm as decoration, because a warped plan offers more
  things to misread than a lattice did.

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

- **The Query Store history, live incidents, and findings views.** SQLSimCity is a map, not an
  assessment tool, and three tabs of tables were not the idea. `FindingsPanel`, `QueryStoreView`, and
  `LiveIncidentsPanel` are deleted along with `findings.ts`, `findingsContracts.ts`, and
  `queryStoreSelection.ts`. **No collection changed.** The backend, probes, fixtures, and archive
  format are untouched: Query Store data still feeds roads, wait lanes, and the address book, and live
  samples still feed road congestion and the new incident pins. `/api/v1/findings` and the
  `SqlSimCity.Findings` project remain in the tree and are simply no longer drawn — removing them
  end-to-end is a clean follow-up.
- The `docs/images/findings.png`, `querystore.png`, and `live.png` screenshots, which showed surfaces
  that no longer exist.
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

- **Query families named only the last loaded page's objects.** Attribution is computed per bounded
  page — `QueryStoreCityAttribution` resolves a plan's object references against an index built from
  *that page's* objects only, so a reference to an object on any other page survives as prose in the
  rationale and never as an id. `mergeCityPage` then took `topQueryFamilies` from the newest page
  wholesale, so once the view finished walking the cursor every family carried only the final page's
  attribution. Measured against a real 10-table database paged three objects at a time, **11 of 12
  families named nothing** by the end of the walk, which is where the "no loaded object named" line in
  the address book came from. Families are now folded across pages like routes already were: object
  ids are unioned, per-object wait shares are unioned and `unattributedWaitMilliseconds` recomputed in
  `BigInt` so the contract's exact-sum invariant still holds, and confidence is recomputed from the
  union rather than inherited — more than one object means the totals belong to no single building, so
  it is `Probable`. The same merged families feed road grading, facility traffic and the wait lanes,
  so those were reading one page's worth of attribution too. The address book now distinguishes the
  two silences it used to collapse together: references that name another database say so, and only a
  family whose plans named no object in this database at all says that.

- **A connected instance reported no object total at all** ([#41]). `DatabaseCityPageV1.TotalObjects`
  was only ever populated on the archive path; the connected source hard-coded `null` because its
  inventory probe used keyset pagination and never counted past the current page. The probe now
  derives its eligibility predicate once in an `eligible_objects` CTE, counts it unbounded in
  `eligible_total`, and cross-joins that single value onto the page. The distinction between "not
  measured" and "measured zero" is preserved exactly: zero rows on the first page is `"0"`, zero rows
  on a later page stays `null` (objects can only vanish mid-walk), and a probe that could not run
  stays `null`. Verified against SQL Server 2025, including the heap, indexed-view, and empty-database
  cases.

  This was more than a missing number. The city grid is sized from `totalObjects`, so with `null` it
  was sized from whatever happened to be loaded — meaning appending a bounded page reshuffled every
  building already on screen, breaking the guarantee the map is built on.

- **A ranked query could claim to name exactly one object while being refused as that object's
  attribution, in the same payload** ([#40]). `ExposureEligible` required `local.Count == 1` *and* no
  off-page, cross-database, or unresolved references, but the rationale sentence tested only the
  cross-database half. A family naming one on-page table plus one off-page table therefore said
  "names exactly one local object" and was simultaneously rejected. Both now read the same predicate,
  and a family in that position says what is actually true: it names one object on this page
  *alongside N further references below*, so the totals stay query-level.

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
- Every building in a connected database city no longer reports its attributed Query Store exposure
  as unavailable. `ConnectedDatabaseCitySource` filtered the Query Store join by the *atlas*
  database id (`{target}/database/{name}`), while connected Query Store history is collected,
  indexed, and keyed by the SQL **database name** — so `ConnectedQueryStoreHistorySource` matched no
  published index set, returned an empty page, and the join reported "no ranked Query Store family
  names this object" for every object, every metric, and every page against a real server. The join
  now filters by the database name, which is the key the history source actually publishes. The unit
  tests could not see this because the in-memory Query Store fake asserted the very id the caller
  passed, so the fake now models the two identifiers as the distinct things they are. Related, an
  index set whose stored database name differs from the requested one only in case now resolves
  rather than silently matching nothing, since SQL Server database names are case-insensitive and
  the collected key can come from `Atlas:KnownDatabases` configuration instead of from the server;
  an ambiguous case-insensitive match still resolves to nothing rather than to a guess.
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

[#40]: https://github.com/cbattlegear/SQLSimCity/issues/40
[#41]: https://github.com/cbattlegear/SQLSimCity/issues/41
