# Architecture and evidence model

SQLSimCity is an evidence-first performance visualization, not a SQL Server emulator and not an
automated tuning service. The API owns data reduction and evidence classification; the browser
renders bounded projections.

## Source layers

```text
src/SqlSimCity.Contracts  versioned transport and evidence contracts
src/SqlSimCity.Domain     source-neutral API seams and fixture sources
src/SqlSimCity.SqlServer  validated connection and authentication strategies
src/SqlSimCity.Collection static SQL probes, capability negotiation, Atlas/City/Query Store/live collectors
src/SqlSimCity.Storage    plaintext protected SQLite records and retention (legacy sealed records still open)
src/SqlSimCity.Archive    hostile-input archive format and offline adapters
src/SqlSimCity.Edge       signed delivery, replay defense, encrypted spool, atomic edge generations
src/SqlSimCity.Api        same-origin HTTP, SignalR, source registration, and static hosting
web/                      React analytical UI and imperative three.js scenes
```

The city and analytical views consume the same versioned contracts in fixture, connected, archive,
and edge modes.

## Evidence boundaries

SQLSimCity keeps materially different evidence types separate:

1. **Query Store aggregates** describe retained intervals. They are not current activity, per-execution
   traces, or actual operator timing.
2. **Live DMV samples** prove what was visible at one sample instant. Requests and blocking that begin
   and end between polls can be missed.
3. **Cumulative DMV counters** produce rates only after two comparable samples in the same reset
   epoch. First samples, resets, and regressions never become fabricated zero or negative rates.
4. **Catalog metadata** describes objects, files, compatibility, and capabilities at collection time.
5. **Attributed/inferred evidence** carries an explicit confidence and rationale. Query-level cost is
   never copied to every object in a multi-object plan.
6. **Unavailable evidence** remains unavailable, permission denied, disconnected, stale, unsupported,
   or not probed. It never becomes numeric zero.

Exact SQL `bigint` and aggregate values cross JSON as decimal strings. The frontend uses `BigInt`
only for exact formatting and converts to bounded numeric scales solely for visual mapping.

## Product surfaces

The UI is one surface: a full-bleed map with a sidebar over it. The map is the product — there is no
tab bar, and no page that is not the map.

The sidebar is a column holding the live query feed and four **accordion regions** — the city
directory, live activity, the captured-plan router, and legend & evidence.
`web/src/sidebarAccordion.ts` allows at most one of the four to be open, so the open one gets the
column and the other three cost only their summary; a live search term pins the directory open,
since its search box is inside it. That rule is the fix for a measured defect rather than a
preference: with all four open at 1440×900, three of them held eighteen pixels of body against tens
of thousands of pixels of content, and the rail still reported zero unreachable pixels, because an
18px `overflow: auto` scroller clips nothing and simply cannot be read.

The live query feed is deliberately *not* one of the four. Sharing the drawers' budget, it was
measured at 1115×800 holding 26px at rest and 5px with everything open — a third of one row — so it
sits beside the directory as the column's other scrolling region, with a floor of its own.

The **city directory** (`web/src/addressBook.ts`) is the address book: one flat, searchable listholding query families, tables, and infrastructure facilities together, each with a measured one-line
summary and an address derived from the city plan (`dbo · Block C4`). One search box matches all three
kinds, so you look up a place rather than first having to know which category it lives in — searching a
table name also surfaces the query families that drive traffic to it. Selecting an entry selects it
on the map and replaces the list with a place card carrying the existing evidence panels verbatim.
An entry whose object is not on the loaded bounded page has no lot, and says so rather than inventing
a location.

The **live query feed** (`web/src/liveQueryFeed.ts`) lists individual executions as they are observed,
folded out of the difference between successive live samples rather than read from any one of them.
Each arrival also sends a vehicle down the road its family graded, so the feed doubles as the map's
caption: a row appearing is the same event as a car pulling away. Selecting a row draws that family's
plan as a route, by the same path a directory click takes. The live sampler is instance-wide, so the
feed is scoped by database name *and* emptied when `databaseId` changes — the reset alone would not
hold, because the very next instance-wide sample would refill it.

Everything else floats over the canvas: the view-mode toggle, camera controls, the layer switches,
a status chip, and the incident summary. The evidence tables and the visual-semantics prose live
behind a "Legend & evidence" disclosure at the foot of that column — kept in full for accessibility
and honesty, but no longer the page. The deployment-security notice and the archive and edge banners
are floating cards that default to visible and are dismissed only by the reader.

### Server atlas

The atlas shows up to 100 databases, and each one is drawn as a small city on a shared grid, not as a
single block. A database is therefore a city at both altitudes: the atlas and the database city read
as two heights over one place rather than as two unrelated diagrams.

Exactly two properties are measured, and they are the pair the database city measures one level down.
Everything else is either a consequence of them or decoration.

| Encoded property | Evidence |
| --- | --- |
| City plot side | known allocated bytes, through the documented logarithmic mapping `t = min(1, log₂(1 + A) / 50)`, `area = 144 + 9072t` |
| Tallest tower height | known used bytes, `log₂(1 + U) × 2.6`, so zero used bytes is zero height |

Block count follows from the plot rather than claiming anything of its own: `web/src/atlasCity.ts`
divides every city at one constant block pitch, so a larger database is a larger city with more
blocks in it and block *size* never varies. Skyline shape, setbacks, masts, and the small per-lot
width variation are decoration seeded from the database's stable id, so a city's shape never changes
between renders and never moves when its measurements do.

Unknown never degrades into a small number, in either direction. Unknown allocated size draws the
nonquantitative × parcel and no city at all; known allocated size with unknown used size draws the
real plot and its real block grid with every lot fenced and empty, because the ground was measured
and the skyline was not.

Every city is named on the ground, with the label vocabulary shared with the database city
(`web/src/cityLabels.ts`). Live concurrency, historical Query Store load, capacity, and data quality
remain separate dimensions, reported in the evidence table rather than in the geometry. A fresh live
sample adds a pulsing beacon over the city, and inferred topology edges keep their own line styles.

Hovering a city reports its name, a click selects it and fills the evidence panel, and a double-click
enters that database's city, so the atlas descends to the next altitude by the same gesture a map
uses. A double-click only opens the city that both of its clicks landed on
(`web/src/atlasActivation.ts`): the browser pairs any two clicks that fall close together in time,
and clicking one database and then its neighbour to compare them must not throw the reader into
either of them. The detail panel's "Enter database city" button stays the keyboard-reachable way to
do the same thing, and the evidence table below stays the non-WebGL one.

Placement and framing are presentation, not evidence, and both exist so the encodings above can
actually be compared by eye. `web/src/atlasLayout.ts` reserves one of a hundred grid slots per
database and hands out the slots nearest the centre first, so a server with eight databases is a
compact cluster rather than eight specks scattered over a thousand units of empty ground; a database
never moves once it holds a slot, and which database claims the centre is decided by its stable id
rather than by arrival order. `web/src/atlasFraming.ts` then solves the camera distance that fits the
cities that exist, against the real viewport shape, by fitting the corners of their bounding box
rather than its bounding sphere — the atlas is a wide, nearly flat subject, and sphere fitting would
stand the camera off as though it were a cube. Distance and direction change what is legible, never
what is claimed.

Cities are merged into one geometry per database and cached by the measurements that shape them, so
the thirty-second atlas refresh rebuilds nothing that did not move.

### Database city

Schemas are stable neighborhoods. Tables and indexed views are buildings sized by exact 8-KiB page
counts. Indexes are attached structures on their parent object. Direct index DMV activity and
Query Store-attributed exposure use different evidence and visual styles.

#### Attributed and shared exposure

Query Store measures one set of totals per query, not per object. A query that joins four tables has
one CPU figure, and nothing in Query Store says how much of it each table caused. SQLSimCity
therefore reports exposure in two separate shapes and never mixes them:

- **Attributed exposure** is assigned to an object only when a ranked query family names that object
  and nothing else — no second local object, no cross-database target, no reference the collector
  could not resolve. Anything less and the totals are not that object's to claim.
- **Shared exposure** carries the query-level totals of families that named the object *alongside
  others*. The figures appear **whole** on every object those families named, because a per-object
  share would have to be invented. `DatabaseCitySharedExposureV1.Rationale` says so in the payload
  itself, and the map draws it as an outlined roof cap rather than a solid one.

Summing shared exposure across buildings double-counts by construction. That is the point: a total
that cannot be divided honestly is better shown repeated, and labelled, than split or hidden.

Without shared exposure a normalized schema renders almost entirely blank, because on such a schema
`local.Count == 1` is close to unreachable — shrink the page and joined tables fall off it, widen it
and they come on-page. The strict attribution rule is deliberately unchanged; shared exposure is what
makes that strictness survivable on a real workload.

#### Estimated wait attribution — a third, clearly-labelled class

Attributed and shared exposure both refuse to divide a query-level total, because *Query Store* holds
nothing that says which table caused what. The **estimated execution plan does**: every `RelOp`
carries `EstimateCPU` and `EstimateIO`, and most carry an `<Object>` reference. That is the
optimizer's own arithmetic about the work it expected each table to require.

So there is a third class, and it is never allowed to impersonate the first two:

- **Estimated wait attribution** takes a family's *measured* wait milliseconds and apportions them
  across the tables its plans read, in proportion to each table's share of the plan's estimated cost.
  The milliseconds are real; the split is a model.

`PlanCostAttribution` computes the shares and `WaitApportionment` performs the division. Three rules
govern the split, and `web/src/planCost.ts` mirrors them exactly for the browser:

1. An operator's own cost is `EstimateCPU + EstimateIO`, never `EstimatedTotalSubtreeCost` — subtree
   cost is cumulative, so summing it double-counts every child at every ancestor. Subtree cost is used
   only as a fallback, as parent-minus-children, when no operator in the plan reports CPU or IO.
2. Cost on an operator that names no object is pushed **down** onto the objects in its subtree,
   proportional to the weight they already carry. The unattributed pool takes its proportional share
   of that pushdown too.
3. A subtree containing no object reference leaves its cost unattributed. It is never nudged onto a
   neighbour.

Only shares for objects the page actually draws are published. Cost spent on an off-page table,
another database, an unresolvable reference, or pure computation stays in
`UnattributedWaitMilliseconds`. The apportionment is exact: fixed-point at 1e9 with largest-remainder
allocation, so the parts plus the remainder reconstruct the measured total byte-for-byte, for any
`BigInteger`. Ties break on object id and the unattributed bucket always sorts last, so the result is
reproducible.

`attributedExposure` and `sharedExposure` are untouched by any of this and keep their exact previous
meaning. The estimated class lives in its own contract field (`DatabaseCityQueryFamilyV1.WaitAttribution`),
its own UI section, and its own legend paragraph, all of which say *modelled, not measured* in those
words. Summing a building's estimated wait with its attributed exposure is meaningless and the UI
never invites it.

The city is laid out as a real street plan rather than a bar chart. `web/src/cityPlan.ts` traces a
street network — see [the landscape section](#the-landscape-around-the-evidence) — recovers the city
blocks it encloses, and hands those blocks out using a seeded generator (`web/src/citySeed.ts`), so a
city looks like a city instead of a packed rectangle while remaining completely deterministic: the
seed is a stable hash of the database's own id, and every draw comes from that one stream. The same
database therefore lays out identically on every load, in every browser, on every machine.

Blocks are not handed out from one city-wide shuffle. `planNeighborhoods` first partitions the
buildable blocks into one **contiguous territory per schema**, so a schema is a quarter of the city
rather than a colour sprinkled across it. Each schema gets a seed block chosen by farthest-point
sampling, and the territories then grow outward a block at a time in rounds, each schema taking
ground until it meets a quota proportional to its full object count. Every block carries a fixed
seeded handicap on its cost, so regions grow as ragged blobs rather than discs and the borders land
wherever two regions happen to meet. A territory that gets walled in falls back to the nearest free
ground, so every object is housed even in a cramped city.

Two rules make that layout safe to build on:

- **Appending a page never moves a building.** The grid is sized from `page.totalObjects` (plus the
  facilities and slack), not from how many objects happen to be loaded. The partition is a function
  of the seed, the grid, and the *full* per-schema counts carried on every page — never of which
  objects have loaded — and an object's block is `objectOrdinal % territory.length`, an index local
  to its own schema. Appending a page therefore fills a neighbourhood in; it never redraws one.
  Filtering the address book does not rearrange the city either.
- **Facilities are spread out.** The six civic facilities are placed first, each drawn from the seeded
  stream and accepted only when its Chebyshev distance to every already-placed facility is at least
  `MIN_FACILITY_BLOCK_GAP` (2 blocks), so infrastructure is distributed across the map rather than
  clustered in one corner. On a grid too small to satisfy that, a deterministic
  maximise-minimum-distance sweep takes over, so a four-table database still lays out — just tighter,
  and still fully determined by the seed.

The plan also emits the intersections and streets that roads are drawn on and that query routes walk,
so nothing is drawn diagonally through a building. Each `CityDistrict` carries the blocks its schema
claimed, a bounding box, and a label anchor averaged over *owned* ground — an L-shaped territory's
bounding-box centre can be a block the schema does not own, so the neighbourhood name is placed on
the centroid of what it actually holds.

#### What a neighbourhood does and does not say

Grouping is evidence: two buildings in the same quarter really are in the same schema, and that is a
catalogue fact you can verify. Everything downstream of the grouping is not:

- **Which block inside the quarter** a building gets is seeded, so adjacent buildings are not related
  by being adjacent.
- **How far apart two neighbourhoods sit**, and which two share a border, is an accident of seeding.
- **The hue** comes from `neighborhoodHue(ordinal)` in `cityPlan.ts` — golden-angle steps over the
  schema's place in the catalogue listing. It is a set of names, not a scale: no hue is larger,
  hotter or busier than another. The hue lives in `cityPlan.ts` rather than in the renderer because
  the sidebar swatch must not load `three`, and a second copy of the formula would be a colour key
  that quietly lies. `neighborhoodTint` (3D) and `neighborhoodSwatch` (CSS) both read it.
- **The tint weight** is 0.26, deliberately low: a skyscraper in the green neighbourhood still has to
  look like a skyscraper. Vacant parcels are never tinted, because unmeasured ground must not be made
  to look like a building.
- **The amount of ground a schema claims** follows its object count, because its growth quota is
  proportional to it — a schema with ten times the tables gets roughly ten times the territory. But
  only roughly: quotas are approximate, borders land wherever two growing regions happen to meet, and
  a walled-in region takes whatever free ground is nearest. Area is a rough impression of how much a
  schema holds, never a figure to read off the map. The exact counts are in the sidebar strip.

Building labels carry the bare object name; the schema name is drawn once across the neighbourhood
instead, set in tracked capitals the way a basemap names an area rather than a thing standing in it.

Every property in the table below encodes evidence. Everything else in the scene is decoration seeded
from an object's stable id and carries no data claim; the in-app legend states this split verbatim.

| Encoded property | Evidence |
| --- | --- |
| Building footprint | log₂ of exact reserved 8-KiB pages |
| Building height | log₂ of exact used 8-KiB pages (zero used pages is zero height) |
| Solid amber roof-cap height | Query Store CPU measured for that object alone |
| Outlined amber roof-cap height | Query Store CPU of queries that also named other objects |
| Index annex width | direct DMV operations on that index |
| Road width | executions of query families naming both endpoints |
| Road colour | captured wait share, graded low/medium/high, upgraded only by a resolved live lock |
| Route line pattern | co-reference confidence (confirmed / probable / unknown) |
| Street traffic width | executions of every query family whose journey runs along that street |
| Street traffic colour | apportioned wait milliseconds per execution on that street |
| Wait-lane width | captured Query Store wait milliseconds from one building to one facility |
| Wait-lane colour | which facility the lane ends at |
| Wait-lane pattern | attribution confidence of the contributing query families |

The two street-traffic rows are the only entries in this table whose *placement* is modelled. The
executions and the wait milliseconds are both measured, but which street carries them depends on an
invented street plan and which table a wait belongs to comes from the plan's cost estimate. Every
surface that shows them says so; see
[estimated wait attribution](#estimated-wait-attribution--a-third-clearly-labelled-class).

Building *archetype* (house, rowhouse, midrise, tower, skyscraper, civic hall, vacant parcel) is
chosen from exact reserved-page thresholds compared as `BigInt`, because page counts are lossless
base-10 strings that can exceed `Number.MAX_SAFE_INTEGER`. The archetype selects style only; the
measured footprint and height are unchanged by it. Unknown size yields a fenced wireframe parcel.

Colour and confidence deliberately occupy independent channels: once colour carries congestion,
confidence moves to line pattern, so neither dimension can be mistaken for the other.

#### The landscape around the evidence

The city stands in a landscape, and none of that landscape is measured. `web/src/cityTerrain.ts`
plans a river, a gentle relief field, and a land use for every block that holds no building — park,
woodland, orchard, greenway, plaza, parking, yard, or open water. Land use is chosen a whole arterial
cell at a time rather than a block at a time, with a minority of blocks breaking ranks along the
boundary, so open ground reads as a region with a ragged edge instead of confetti.

The street network is not a lattice, and it is not a wiggled lattice either. Bending a road between
two fixed lattice points leaves two lattice points, and it is the *junctions* the eye reads a street
plan by. So the streets are not laid out at all; they are **traced**, and the blocks are whatever
they enclose. Five modules do it, and none of them ever sees a measurement:

- **`cityField.ts`** plans a **tensor field** over the city — a direction for every point on the
  ground. A tensor rather than a vector because a tensor carries *two* perpendicular directions at
  once: trace one family of streets along the first and the cross streets along the second, and
  because the eigenvectors of a symmetric tensor are orthogonal by construction the two families meet
  at right angles everywhere while both curve freely. It is stored as `(a, b) = (R·cos2θ, R·sin2θ)`;
  the doubled angle is what makes a street running north–south identical to one running south–north,
  and it is what lets two fields be blended by ordinary addition, which averaging angles cannot do.
  The field is a sum of district grains — a few dozen to a couple of hundred overlapping quarters,
  each with its own bearing, extent and falloff, some laid out around a point rather than along a
  bearing — plus a boundary term that turns streets to run along the river rather than into it.
- **`cityStreamlines.ts`** traces streets by integrating the field with RK4 from seed points, growing
  the network outward from what already exists, and stopping a street when it comes within half a
  separation of another. That one rule is what produces the characteristic look: streets end where
  they meet other streets, in T-junctions, without anything having decided to make a T-junction.
  Propagation alone cannot cover a radial field — spokes diverge, so no seed dropped beside one ever
  lands in the widening gap — so afterwards the plan is swept for ground no street came near and the
  uncovered points are seeded and traced again. Coverage only ever grows, which is what lets the
  sweep be cheap: the candidate grid is laid out once and each pass hands the next only the cells it
  could not cover, so the second sweep and every sweep after it ignore the whole built-up map. It is
  also what makes the sweep correct to skip that ground, and the invariant is asserted directly in
  `cityStreamlines.test.ts` because nothing else would notice it breaking.
- **`cityGraph.ts`** turns the traced curves into a planar graph — splitting them at their crossings,
  welding coincident junctions, snapping near misses onto the network and trimming stubs that stop in
  open ground — and then walks the graph's faces to recover the city blocks. It also breaks a share of
  the crossroads down into pairs of T-junctions, because tracing two orthogonal families produces more
  four-way junctions than a real city has. Finally it joins any stranded pocket of streets to the rest
  by a link road across the shortest gap — see *Islands* below.
- **`cityBlocks.ts`** insets each face by the pavement setback to get the buildable ground inside it,
  and measures how many lots that ground will hold.
- **`cityRouting.ts`** assigns each street a class, a speed limit and a width.

A district's extent is derived from the spacing the districts actually have, never from the city
radius. This is easy to get wrong and the symptom is delayed: the count of districts grows with area,
so sizing each one as a fraction of the radius makes the grain coarsen with every table added, and a
district large enough simply *is* a city-wide element under another name. The largest instances
spiralled for exactly this reason while every small one looked right. The rule generalises — **anything
sized as a fraction of the city radius eventually becomes a city-wide element.**

The city's own radius is `RADIUS_PER_ROOT_OBJECT · √objects` separations, and that constant is worth
respecting because its effect is quadratic. A traced block covers roughly 1.34 separations squared,
so a disc of that radius holds about `2.3 · k²` blocks per object: at `k = 1.75` every building has
nine blocks to itself and the map is four fifths empty, at `k = 1.0` it has a little over two. The
difference is not only cosmetic — every stage downstream, from tracing to growing neighbourhoods,
pays for ground nothing stands on. `RADIUS_FLOOR_STEPS` puts a floor under small cities, where the
blocks fall off with a disc's area while the buildings that need them do not, and it has to be large
enough that a nine-table database still has more blocks than tables after the setback and capacity
filters take their share.

###### Islands

Tracing can strand a pocket of streets with no way in, where one quarter's grain turns hard against
its neighbour's and the seam between them opens wider than the radius within which loose ends get
snapped together. It is the worst kind of fault because it is invisible: the pocket draws perfectly,
blocks and all, and the only symptom is a query ribbon that never appears — which looks exactly like a
query that was never run. `connectComponents` links each island to the main network across its closest
approach, smallest gap first so that a chain of pockets can link out through its neighbour. It runs
*after* the faces are walked, so blocks are still recovered from a strictly planar graph and only the
routing network gains the road. In practice it adds one edge in a city of five hundred, and none in
most.

There is deliberately **no city-wide element in the field** — no ring road, no radial spokes, no
centre. Three attempts at one all failed the same way, and the failures are worth recording because
each looked correct in the code. A single radial element at the middle produces a dozen perfectly
concentric rings converging on a point, so the most ordered part of the map is exactly where a real
city is most tangled. Adding noise to break them up turns the rings into a **spiral**: a street
tracing a ring comes back round about one street's width inside where it began, carries on, and does
it again — and no rule objects, because each arm of the spiral is a legal distance from the last. And
peaking the element on a *circle* rather than a point removes the whirlpool but still yields four or
five concentric rings sitting on the ring line, because a field cannot say "exactly one ring road": it
gives a direction everywhere, and the tracer fills the space with streets parallel to it. Even at a
third of a district's weight the nest of arcs was the first thing the eye found.

So the large scale is left to emerge instead. Overlapping district grains already bend long streets
into arcs that cross several quarters, and the classification pass below discovers which of them the
network actually depends on. The city ends up with a legible skeleton and a centre without either
having been drawn, which is also how the real thing happened. District grain scales with distance
from the middle, so the core is a mosaic of small parcels laid out one at a time and the outskirts
are single large plans — a medieval centre and a post-war estate, from one line of arithmetic.

Boeing's survey of 27,000 street networks ([arxiv.org/abs/1705.02198](https://arxiv.org/abs/1705.02198))
puts a real city at roughly 57% T-junctions, 14.5% dead ends and only 23% four-way crossings, with a
mean node degree of 2.7–3.0; a lattice is 100% four-way at 4.0, which is exactly why it reads as
graph paper. The traced network measures 23.7–25.6% four-way, 41–47% T, 13–20% dead ends and mean
degree 2.73–2.83 across seeds, and holds that range from a hundred-table database to a six-thousand
-table one. The tests assert it.

##### Road hierarchy, speed limits and where the traffic goes

A street's importance is not asserted, it is **measured on the network**: `classifyRoads` computes
edge betweenness — for every pair of junctions, the share of shortest routes between them that use
each street — and the streets everything has to pass through are the ones that come out highest. That
is the definition of an arterial road, and discovering it rather than declaring it is why the
hierarchy lands on roads that genuinely go somewhere.

Classification is by **rank**, not by score. Scoring against the busiest street assumes the
distribution has a clear peak; a city of overlapping grains has many roughly equal cross-town routes
instead, they all sit near the maximum, and a third of the network came out as arterial. Fixing the
proportions instead — the busiest 3% are motorways, to 9% primary, 19% secondary, 35% tertiary, 80%
residential, the rest service roads — guarantees the ladder reads on any network from six tables to
six thousand. It is also the honest reading of what betweenness measures: a ranking, not an absolute.
"This street is in the busiest three per cent" is exactly the claim the algorithm supports. Class then
sets a speed limit and a carriageway width.

Query routes are then driven like a satnav rather than walked. `RoadRouter` is A* over **travel
time** — length over speed limit — with states on *directed* edges rather than on junctions, which is
the only way to charge for turns at all: at a junction you have no idea which way the journey arrived,
so there is nothing to compare the departure against. Turn penalties are what stop a route zig-zagging
block by block toward its destination when the staircase happens to measure a metre shorter, and
following a road as it bends costs nothing because headings are taken from the vertices next to the
junction rather than the far ends of the streets.

`cityAssignment.ts` closes the loop with the workload. Each ranked query family contributes trips
between the objects it named, in proportion to its measured execution count, and those trips are
loaded onto the network incrementally: route a journey, add its traffic, recost the streets it filled
with the standard BPR congestion curve, route the next. So a busy corridor gets slower as it fills and
later journeys find their own way round, which is why two heavy families between the same pair of
buildings are drawn on different roads instead of on top of each other. Three details matter:

- **Costs are updated after every journey, not once per wave**, which is what a textbook incremental
  assignment does. Per-wave recosting converges on the right flows but draws identical journeys
  identically, and the whole point here is that they diverge.
- **The congestion ceiling clamps the load, not the resulting delay.** Clamping the delay makes every
  jammed street cost the same, the router can no longer tell them apart, and it silently reverts to
  shortest path — the exact opposite of the intent.
- **Each family is drawn on its modal route across the waves, not its final one.** Routing once more
  over settled traffic puts a family's own trips in its way, so a family big enough to fill a street
  gets diverted around traffic that is entirely its own, and is drawn on a back street while the main
  road it actually filled sits empty.

Trips are normalised to a unit total before loading, so how congested the map looks is a property of
the *shape* of the workload and not of how busy the server happened to be that hour. The demand is
measured and used verbatim; the route it takes is not evidence and never was.

Because a six-thousand-table database draws a city with five and a half thousand junctions, the
betweenness sweep samples its sources above a few hundred junctions and scales the totals back up —
the standard estimator for this measure. It is an unusually safe approximation here because the result
is only used as a ranking and the band edges are quantiles of the same distribution; a test measures
the sampled ranking against the exact one by rank correlation rather than trusting it.

Streets carry a sampled `path` rather than two endpoints, so roads that run with the river become
embankments and roads that cross it become bridge decks. Because a traced street's carriageway is
nowhere near the straight-line midpoint of its junctions, `rebindFrontages` runs after placement and
snaps every lot's access point onto the nearest point of a drawn path — the door lands on the road you
can see. Trees, hedges, street furniture, parked cars, rooftop clutter, the architecture of the six
facility shells, and the golden-hour sky, fog and shadows are all generated from the same database-id
seed. The generator scripts for the Blender-authored kits live in `blender/` so every `.glb` in
`web/src/assets/` is reproducible and auditable; regenerate them by running
`blender --background --python blender/simcity_kit.py`.

None of this is derived from a measurement, so none of it can be read as one — a park is not idle
space, a curving street is not a slow query, a big block is not a big table, a dead end is not a
table nothing reaches, a motorway is not a hot table, a speed limit is not a latency, congestion on a
street is not contention in the database, and a neighbourhood with a sparser street pattern is not a
sparser schema. The in-app legend says so in as many words under "The scenery is not evidence" and
"The street plan is drawn too".

CPU, memory, storage, tempdb, log, and lock evidence from `/api/v1/live` are placed as six civic
facilities scattered across the grid (`web/src/cityInfrastructure.ts`). Each facility's architecture
is fixed decoration so its location stays learnable with no evidence at all; only the *height* of the
measured units inside it varies, interpolated between a documented floor and ceiling. A subsystem
that could not be sampled renders as a wireframe with its reason and claims nothing.

#### Map view and city view

The same object graph is drawn two ways, switched by one toggle (`web/src/mapStyle.ts`). There is one
scene, one raycaster, and one set of controls in both modes — the mode changes appearance, never
content, so anything selectable in 3D is selectable on the flat map.

| | Map view | City view |
| --- | --- | --- |
| Camera | narrowed to a 13° field of view with the polar angle locked flat, which is parallel projection for practical purposes | oblique perspective, free orbit |
| Lighting | a single white ambient light, so materials render as their flat base colour | hemisphere, key, and fill lights |
| Massing | buildings collapse to footprint plates — height is a claim the 3D view makes, not this one | full height |
| Roads | white fill over a grey casing, drawn from the sidewalk strips the lattice already had | asphalt with kerbs |
| Facilities | teardrop POI pins | full facility geometry |

Road colour survives the switch in both directions, because congestion colour is measured evidence
rather than styling. Only the drawing style changes.

#### Incident pins

`web/src/cityIncidents.ts` projects a live snapshot into map pins: a blocked waiter, or a session
caught in a cycle in the current wait graph, anchored to the building whose lock it is waiting on.
`IncidentPopup.tsx` draws the callout as HTML over the canvas so the text is real text — selectable,
screen-reader reachable, legible at any zoom.

The projection follows the same evidence rule as everything else, and the distinctions are load-bearing:

- A snapshot that never carried a `lockResource` field means the probe did not run. That is reported
  as "not observed", never as "no blocking".
- A lock that resolves to a real object outside the loaded bounded page is **counted** as an off-map
  incident rather than pinned to the nearest available lot.
- A lock that names no object at all — a page lock, a database lock — is listed with the parser's own
  reason rather than guessed onto a building.
- A cycle in the *current* wait graph is reported as exactly that. SQL Server resolves real deadlocks
  before they can be sampled in `sys.dm_exec_requests`, so the popup says what was measured.

#### Waits as traffic to infrastructure

Roads answer "which objects are named together". **Wait lanes** answer a different question — "where
did the time go" — so they are a separate layer (`web/src/cityFacilityTraffic.ts`), toggled
separately. Query Store `wait_category_desc` totals, already collected by the Query Store probes,
are carried on `DatabaseCityQueryFamilyV1.WaitMillisecondsByCategory` and routed to the facility
that owns the resource: CPU and Worker Thread to the Scheduler Yard, Memory to the Memory Grant
Office, Buffer IO and Other Disk IO to the Storage Depot, Tran Log IO and Log Rate Governor to the
Log Yard, Lock to the Lock Authority.

Three refusals keep the layer honest, and each is enforced by a test:

1. A family naming more than one object is **never divided** between them. Query Store reports one
   wait total per query, not per object, so splitting it would fabricate a per-building number. Those
   milliseconds are reported whole in a separate list.
2. A category with no counterpart in this city — Parallelism, Network IO, Compilation, Idle,
   Preemptive — is **never folded into the CPU yard**. It is listed with the reason it has no
   destination.
3. `Buffer Latch` is **not** routed to tempdb Works, even though tempdb allocation contention is its
   most famous cause, because the category does not name a database. tempdb therefore has no Query
   Store lane at all.

A building with no lane is not idle. `sys.query_store_wait_stats` does not exist before SQL Server
2017 (14.x), so an absent breakdown is stated in prose rather than drawn as a zero-width lane, and
an unrecognised category is reported verbatim rather than routed to a guessed facility. Lane width
saturates at a documented ceiling; past it the lane says its width is a floor and defers to the
exact figure in the evidence table.

The backend returns bounded object pages, a fixed top-query-family set, and an exact `other workload`
aggregate. The browser never receives all 100,000 query families.

Routes indicate co-reference or cross-database evidence. Solid, dashed, and dotted styles mean
confirmed, probable, and unknown; they do not imply row direction or row flow.

#### Query plan routes

Selecting a Query Store plan draws a GPS-style route through the city (`web/src/cityRoute.ts`).
**Every stop is a table.** A query does not drive to a wait facility and come back; it reads tables,
and the waiting happens while it does. Routing through the six civic facilities made the itinerary
read as a detour between real destinations, which is not what a plan does, so it was removed.

The normalized showplan's operator tree is walked in post-order and each operator is assigned to a
building:

1. an operator with a resolvable object reference belongs to that building;
2. an operator naming no object folds onto the **heaviest table in its own subtree**, measured by
   estimated own cost, with ties broken on a stable key so the result is deterministic;
3. an operator whose subtree contains no on-page table at all becomes an *unplaced operation*, listed
   separately rather than attached to whichever building happened to be nearby.

Stop order is the order tables are first reached in that walk. Each stop carries the operators that
happen there, its share of the plan's estimated cost, and — for each operator — the resource it
leans on, drawn from the same `facilityForOperator` classification as before. The facility is now a
**property of the operation** rather than a destination on the route.

Consecutive stops are joined by a shortest path over the street graph, so the route follows roads.
An object reference that names something outside the loaded bounded page becomes an explicit off-map
stop with a reason; it keeps its place in the itinerary so the sequence stays whole, but the drawn
line skips it and the panel says so. The route is a compiled plan shape and carries the plan's
`runtimeOverlayCaveat` verbatim: it is never actual operator progress.

#### The traffic map

A single plan's route answers "what does *this* query do". Standing back from the city, the question
is "what does the *workload* do", and one ribbon per pair of co-referenced tables answers neither —
it draws the join graph, not the traffic.

So `web/src/cityWorkloadTraffic.ts` builds the default view: every ranked query family is driven
through the tables its plans read, ordered from its highest cost share outward by nearest neighbour,
and each street it uses accumulates that family's captured executions and its apportioned wait
milliseconds. Two channels come out of it, and they are deliberately **not** blended:

- **Width** is executions — a count.
- **Colour** is apportioned wait milliseconds *per execution* — a duration per unit of work.

A count and a duration have no honest common unit. Combining them into one "traffic level" scalar
would require inventing an exchange rate between an execution and a millisecond, so the map shows
both and lets the eye do the join: wide and dark red is a street a lot of queries use and wait on.
The grade cut points (5 ms/execution for medium, 50 for high) are invented thresholds on a measured
ratio, exactly as the existing `MEDIUM_WAIT_SHARE`/`HIGH_WAIT_SHARE` road grades are. A street with
no apportioned wait grades `unknown`, never `low`, because zero attributed wait is an absence of
evidence rather than evidence of speed.

Accumulation follows each family's **modal route** — the same path the map draws — rather than the
assignment's spread flow, so the numerator, the denominator and the drawn line all agree. A family's
apportioned wait is spread across the legs of its journey by adjacency: the two end stops have one
adjacent leg each and give it their share whole, an interior stop has two and splits its share evenly
between them. Summed over the legs that returns the family's apportioned total exactly, which is the
same reconciliation rule the per-building apportionment obeys; charging each leg half of both its
endpoints instead would have quietly discarded the outer halves of the first and last stop.

Both channels are then **per-traversal intensities**, not divisible shares: a street is charged the
whole executions and the whole leg wait of every journey crossing it, the way a traffic count on a
road is the count on that road rather than a slice of a city total. Summing either channel across
streets is meaningless; dividing one by the other on a single street is the only use they are put to.
Per-query co-reference ribbons remain available on an opt-in `paths` layer.

The camera is a full orbit/pan/zoom control with keyboard equivalents (arrows pan, `+`/`-` zoom,
`[`/`]` rotate, `Home` resets). Fit-to-bounds runs on first load and on an explicit reset only, so
filtering or a live tick never yanks the viewpoint. The full evidence tables remain below the map as
the text-first, non-WebGL equivalent.

## Evidence layers

These are collection layers, not screens. Each one is collected in full by the backend and surfaces
on the map: Query Store aggregates become roads, wait lanes, and address-book metrics; live samples
become road congestion and incident pins.

> [!NOTE]
> Findings has been removed end-to-end. SQLSimCity is a map and evidence explorer, not an
> assessment engine. The retired `/api/v1/findings` route family returns a JSON `410 Gone`.

### Query Store aggregates

Query families preserve physical query/context splits, regular/aborted/exception execution types,
replica groups, reset epochs, plan forcing state, and PSP/OPPO relationships where supported.
Dispatcher runtime is excluded while variant runtime remains attached to its plan.

Raw SQL text and Showplan XML are on-demand protected payloads only. The normalized Showplan parser
prohibits DTDs/resolvers and applies depth, node, text, and character limits. Query Store supplies
compiled plans and query-level aggregates, never actual operator progress.

### Live sampling

The live sampler exposes current requests and sessions, every visible task-level wait, MARS and
parallel blocking edges, root blockers, memory grants, tempdb, file I/O deltas, scheduler pressure,
and log-space gauges. Every snapshot includes source, collection, and freshness timestamps plus
missed/skipped-cycle counts.

The `-2`, `-3`, `-4`, and `-5` blocking-session sentinels remain explicit. `-5` is diagnostic and is
not counted as a blocker incident by itself.

Lock resources are parsed from the engine's verbatim `wait_resource` / `resource_description` text by
`LockResourceParser`, which resolves only what the text actually states. `OBJECT:` and `TAB:` carry an
object id outright. `KEY:`, `HOBT:`, and `ALLOCUNIT:` carry only a `hobt_id` and are reported
`RequiresLookup` until the bounded `sessions.lock_resource_objects` probe resolves them through
`sys.partitions` in the owning database. `PAGE:` and `RID:` name a physical location whose object
would need `sys.dm_db_page_info` or an allocation scan, so they are reported `Unresolvable` with that
reason and are never guessed. `DATABASE`, `FILE`, `EXTENT`, `APPLICATION`, and `METADATA` locks are
reported `NotObjectScoped`. An unrecognised prefix stays `Unrecognized` rather than being coerced.

`LockResource` is optional throughout the live contracts, so its absence means the probe did not run,
not that a request holds no lock. Parsing runs on every sampled request and waiting task in both
connected and fixture mode, because it is pure and costs nothing. The hobt-resolving lookup step is a
separate, bounded call: the fixture declares a sanitized resolution table so the resolved path is
demonstrable offline, and a connected collector that has not yet issued the probe simply reports
`RequiresLookup` and names the probe that would resolve it. The city consumes the result twice — to
upgrade a road to red congestion, and to place an incident pin — and only where a resolved lock names
one of the loaded objects.

## Acquisition modes

- **Fixture** is deterministic and opens no SQL or identity network connection.
- **Connected** runs the embedded, startup-validated, static read-only SQL probe catalog.
- **Archive** validates one mounted redacted observation archive before publishing any section and
  performs no SQL/identity network calls.
- **Edge** accepts signed, replay-protected generations from an outward-only connector and publishes
  only complete, target-isolated generations.

Archive and edge live evidence is static point-in-time evidence. The central service does not turn it
into a continuous trace.

## Scale and lifecycle

- Atlas summaries load before database-city or query detail.
- Query Store uses keyset pagination, chunked index pages, individually addressable/chunked detail,
  a final publication pointer, and a configurable retention horizon defaulting to 24 hours of both
  detail and hourly rollups.
- Database-city layout is deterministic and independent of source row order.
- Live samplers, channels, publishers, edge spools, idempotency maps, and replay journals are bounded.
- three.js frame loops reuse objects and pools rather than allocating per frame.

The deterministic release gates cover 100 databases and 100,000 query families without committing a
giant fixture or loading that population into browser memory.

## API shape

Primary read-only groups:

```text
/api/v1/atlas
/api/v1/capabilities
/api/v1/database-city
/api/v1/query-store
/api/v1/live
```

`/api/v1/edge/ingest` is the sole bounded POST route and exists only when edge ingestion is explicitly
enabled. All responses are same-origin, rate/body bounded, and carry evidence/status fields rather
than success-shaped empty values.

Capabilities use the acquisition source, never fixture profiles for a connected target. A host-owned
collector negotiates on startup and after each Atlas refresh interval (60 seconds for live-only
connections); HTTP reads only return its latest bounded snapshot. The profile's feature fields refer
to the configured initial database. Query Store availability also covers configured or discovered
databases, up to the Atlas 100-database bound, with truncation disclosed. Target
identity/discovery/server-permission results are shared only within one refresh, avoiding
repeated target-wide probes for every database; database-local permission and metadata probes stay
distinct. All target-wide probes run again on the next refresh. Observation timestamps
remain those of negotiation, including explicit permission/unavailable results. Before the first
cycle, the configured target is `NotProbed` with no evidence observation time; the required snapshot
and profile timestamp fields use the Unix epoch, not a fabricated current observation.
Archive and edge modes retain their captured capability identities and observation times.
