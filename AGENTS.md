# Working in this repository

Conventions for coding agents. Everything here was learned by getting it wrong first; the
specifics matter more than the general advice.

## Layout and CSS changes must be measured in a real browser

**A UI change is not verified until it has been measured in a running browser.** Run `npm run dev`
in `web/` and take real numbers.

This is not a style preference. The test suite reads `web/src/App.css` as *source text*: it can
confirm that a declaration exists, and it cannot see the layout that results. Two real defects in
this codebase were invisible to a green suite:

- The sidebar rendered `.sidebar-scroll` while the stylesheet only styled `.sidebar-body`, so the
  column had no scroll container at all and everything past the fold was unreachable.
- A fix that added `min-height: 0` to `.sidebar-drawer` squeezed the drawer to **10px** and clipped
  the summary you click to open it. Every test passed.

For any change touching layout, record before/after numbers for the elements involved:

```js
const el = document.querySelector('.map-sidebar')
console.log(el.clientHeight, el.scrollHeight, getComputedStyle(el).overflowY)
```

`scrollHeight > clientHeight` with `overflow: hidden` means content is clipped and unreachable.
That is the bug signature to look for. Also check that you have not created nested scroll traps,
and that scrolling does not chain into the map canvas — `.map-shell` is `position: fixed`.

**Zero unreachable pixels is necessary, not sufficient.** A column where the address list is 0px and
the place card is 12px does not overflow and is still useless — the same class of mistake as the
10px drawer. Record the actual heights of the sections that gave way, not just the overflow number,
and say whether the result is usable.

The sharpest usability check is a **trusted** click. `locator.click()` hit-tests, so it fails when a
sibling overlaps the target; that is how the #65 column turned out to be uninteractable and not
merely unreadable. `element.click()` via `evaluate`, and `click({ force: true })`, both bypass
hit-testing and will pass while the defect is still there — use them only to reach a later state,
never as evidence. Report the trusted click as its own pass/fail line, with the timing.

Measure at **both** breakpoints. The sidebar is a rail above 860px and a bottom sheet at or below
it, and the two behave differently on purpose.

Put the measured numbers in the pull request body.

### Reaching the city view

`npm run dev` alone serves the atlas but not the city column — that needs the API. Run SQL Server
locally, point `ConnectionStrings__SqlSimCity` at it, `dotnet run --project src\SqlSimCity.Api
--urls http://127.0.0.1:5080`, and open `?view=city&database=<endpoint>%2Fdatabase%2F<db>`.

The plan finder is empty until Query Store has captured something, and an empty finder is a short
form that hides every height defect in that drawer. Query Store's default `QUERY_CAPTURE_MODE =
AUTO` discards cheap ad-hoc queries, so a seed workload can run and still leave one family behind;
set `QUERY_CAPTURE_MODE = ALL` before seeding. Submitting the finder with an **empty** search term
lists everything, which is the reliable way to populate it. Measure the real component with real
rows rather than reconstructing the column out of a different drawer's content.

## A new test must fail against the broken state

Before claiming a regression test works, revert the fix and watch the test fail:

```powershell
git stash            # or: git checkout origin/main -- web/src/App.css
npm test -- --run
git stash pop
```

A guard that passes against the broken state is worse than no guard, because it advertises
protection it does not provide. Say in the pull request that you checked this.

The same applies when you refactor test helpers: confirm the *existing* assertions still bind and
have not started passing vacuously.

### `ownRule()` in `mobileLayout.test.ts` silently retargets

`ownRule()` strips `@media` wrappers and returns the **last** matching rule. Adding a narrow-width
override for a selector will therefore repoint existing desktop assertions at the override, and
they may keep passing while asserting the wrong rule. The helper splits the stylesheet into
desktop and sheet sources for this reason — use that split rather than adding a new mechanism.

The media split does not save you from the **second** face of this, because the retarget can happen
*within* one source. `ownRule()` matches its selector followed by an **optional pseudo-class group**,
and still returns the last match — so `ownRule('.sidebar-drawer > summary')` resolves to the body of
`.sidebar-drawer > summary:hover`, which is declared after it. An assertion about `display` on that
selector therefore reads the hover rule, and passes happily against a stylesheet where the base rule
sets `display: flex`. That is a guard advertising protection it does not provide, and only a mutation
found it.

When asserting that a declaration is **absent** — the negative form, which is where this bites —
iterate `rules(css)` and check *every* rule whose selector is the target or starts with `target:`.
Reserve `ownRule()` for reading a value you expect to be present.

## `App.css` source order is load-bearing

A media query adds no specificity, so same-specificity rules resolve by source order. Base rules
for `.sidebar-drawer` and friends sit near the **end** of the file, *after* the first
`@media (max-width: 860px)` block. Narrow overrides written into that first block silently lose.

Narrow-width overrides belong in the second `@media (max-width: 860px)` block at the end of the
file. Verify the line numbers before assuming which rule wins.

## `<details>` floors on `::details-content`, not on `<summary>`

`<details>` wraps its children in a `::details-content` box, and *that* box is the flex item —
not the `<summary>`, and not `.sidebar-drawer-body`. It is `display: block` with
`min-height: auto` and floors on its own content no matter how hard a flex column pushes.

No `flex` arrangement on `.map-sidebar`'s children can shrink it. Do not add `min-height: 0` to
`.sidebar-drawer` to try: that is the 10px-drawer defect above, and it is pinned by
`never shrinks the legend drawer past its own summary`.

Cap the box itself instead. `.sidebar-drawer::details-content` is given `min-height: 0` so it can
give way, plus `display: flex; flex-direction: column` so the shrink reaches `.sidebar-drawer-body`,
which is already a `min-height: 0; overflow: auto` scroller. The legend then scrolls inside the
drawer rather than spilling out of the rail. An engine without `::details-content` skips the rule
and does not need it: without that box the summary and the body are the flex items directly, and the
body already scrolls. The defect exists only where the box does.

`.sidebar-drawer` keeps `min-height: auto`, and a flex item's automatic minimum is its content size
clamped by its own definite `max-height`. So each drawer still floors at `min(content, cap)` —
summary always inside that. Two open drawers therefore cannot both shrink out of the way.

That is why the cap is no longer a flat `46vh` per drawer. Two drawers each floored at 46vh floor at
46vh *each*, and 2 × 368 does not fit an 800px rail: measured at 1115×800 with a populated plan
finder, 167px of the city column was unreachable, the address list was squeezed to 0px, and its
entries stopped being clickable at all. So a `.sidebar-drawers` wrapper owns one budget and the
drawers inside divide it via `--sidebar-drawer-cap`, half each by default and widened by a `:has()`
rule when only one is open. The drawer's `max-height: var(--sidebar-drawer-cap, 46vh)` fallback is
what keeps an *unwrapped* drawer — the atlas — byte-identical.

Two traps in that arrangement, both of which fail quietly:

- **Never put `:where()` inside that `:has()`.** `:has()` takes a *relative* selector list, in which
  a selector may start with a combinator; `:where()` takes a *complex* one, in which it may not. So
  `:where(> .sidebar-drawer[open] ~ …)` has its argument dropped by forgiving parsing rather than
  failing — Chromium reads the rule back as `:not(:has(:where()))`, which matches everything, so the
  widened cap applies with both drawers open and the overflow returns. Plain `:not(:has(> …))` is
  correct: `:not()` is *not* forgiving, so an engine without `:has()` drops the whole rule and lands
  on the half share, which always fits.
- **`display: contents` removes a box, not an element.** At ≤860px the wrapper is `display:
  contents`, so `.map-sidebar > *` goes on matching the *wrapper* while the drawers are the flex
  items — hence `.sidebar-drawers > *` alongside it in that block. Custom properties still inherit
  through it too, so the drawers keep inheriting a 23vh half-share there; `max-height: none` in the
  same block is the only thing discarding it, and weakening that gives the sheet a *tighter* cap
  than existed before the wrapper.

There are three `.sidebar-drawer` instances — one in `App.tsx` and two in `DatabaseCityView.tsx`.
Check the change against more than one. The two in `DatabaseCityView.tsx` are siblings in the same
column, so they are the case where the caps compete.

`.sidebar-place-card` is a third `46vh` consumer on that same column and is *not* part of the
budget. It shrinks freely, so it does not overflow the rail, but it is squeezed hard: measured at
1115×800 with a place card open and both drawers open, it holds 81px and scrolls its own content.

## The city scene renders on demand, and the shadow map is not automatic

`DatabaseCityScene.ts` does not run a permanent `requestAnimationFrame` loop. It renders when
something changed, and `shadowMap.autoUpdate` is **off** — issue #90 measured the shadow pass at
948 draw calls and 7.6 ms *per frame*, all of it redrawing shadows for a city that had not moved.
Shadows are re-rendered by setting `shadowMap.needsUpdate = true` at the few moments the scene's
contents or its light actually change, never on camera movement.

That makes the shadow cost invisible in the usual places. `renderer.info.render.calls` folds the
shadow pass in with the visible one, and a frame time taken while nothing is animating measures a
scene that is not rendering at all. Use `tools/measure-browser`, which counts submissions off the
WebGL context and splits them by bound framebuffer, so **offscreen draw calls are the shadow pass**.
`median 0` with an occasional `max 948` is the shape that means "on demand and still working";
a steady 948 means something re-armed it and a steady 0 means shadows were switched off entirely.

Two consequences for any loop added later — both fail silently, and both are pinned by
`shadowInvalidation.test.ts`:

- **A new loop gets its own handle.** There are now three (`animationHandle` for the render-on-
  demand pass, `dampingHandle` for orbit inertia, `vehicleHandle` for live vehicles). Reusing one
  handle for two loops means whichever `cancelAnimationFrame` runs last silently orphans the other,
  which then runs forever with nothing able to stop it. Cancel every handle in `dispose()`.
- **A loop that moves objects must not invalidate the shadow map.** Vehicles animate every frame,
  so a single `shadowMap.needsUpdate = true` inside `runVehicleLoop` re-arms the whole 948-call
  pass on every frame and gives back exactly what #90 removed. Vehicles are therefore excluded from
  shadow casting outright (`castShadow = false`), which is also why they need no invalidation.

A loop must also **stop on its own** when there is nothing left to move — an empty roster ends the
loop rather than scheduling an idle frame forever. Measure that, do not reason about it: an
always-scheduled callback that does no work looks identical in a screenshot and identical in the
test suite, and shows up only as a machine that never goes idle.

`shadowInvalidation.test.ts` guards this by slicing `DatabaseCityScene.ts` as **source text** and
asserting a region does not mention `needsUpdate`. Two traps follow from that. It strips comments
first (`code()`), because otherwise a doc comment *explaining* the rule reads as a violation of it.
And each slice is bounded by a named anchor further down the file, so **adding a function between
two anchors silently extends the slice above it** and the guard starts asserting about code it was
never written for. Check the anchors when you add anything near a loop.

Anchors are used the same way outside that file — `cityVehicleAssets.test.ts` and
`cityVehicleLegibility.test.ts` both slice `VEHICLE_SIZE` out of `DatabaseCityScene.ts` — and there
the failure is sharper. **Promoting a declaration to module scope moves an anchor, and if it ends up
*above* the start anchor the window inverts.** `String.slice(from, to)` with `to < from` returns the
empty string, so every lookup inside the slice finds nothing. Hoisting `VEHICLE_Y` to the top of the
file to derive the trail height did exactly this to both files at once.

So assert `to > from`, not merely that each `indexOf` cleared `-1`. An inverted window and a renamed
anchor are different bugs and only the stricter check catches both. Prefer an end anchor that is
declared close to the start one and is unlikely to be hoisted.

## NuGet lock files move together

The repo uses Central Package Management (`Directory.Packages.props`) with `packages.lock.json`
in all 19 projects, and CI restores with `--locked-mode`.

Changing any package version means regenerating **all** the lock files, not just the obviously
affected ones. Transitive and `CentralTransitive` entries appear in projects that never reference
the package directly — `src/SqlSimCity.Archive.Tool` is the usual casualty:

```powershell
dotnet restore SqlSimCity.slnx --force-evaluate
```

Commit every lock file this touches. Skipping it produces `NU1004` across many projects, where
the real instruction is buried in the noise.

Do not weaken `--locked-mode` in CI to get around this. It is a supply-chain control.

## A negative descriptor is a permanent answer unless the cache is stamped

Query text is normalized once per `query_text_id` and the *result* is cached — including a
`Missing` result. That cache is deliberately excluded from plan-cache eviction (a `Missing`
descriptor is the record of *why* there is no text, so discarding it would re-ask the source for
something it already refused). The consequence is easy to miss: **improving `SqlTextNormalizer`
changes nothing on any instance that has already run.** Every text the old normalizer rejected is
on disk as a rejection, and the read is a hit, so the new code is never reached.

That is not hypothetical. Query Store records a parameterized statement as its sp_executesql
parameter declaration followed by the statement — `(@P0 int)SELECT ...` — which no T-SQL parser
accepts as a batch. On an Azure SQL database driven by any ORM or prepared-statement client that is
nearly the whole workload: measured against a live instance, **167 of 172 query families had no
text at all**, which empties the plan finder, strips the labels off the city's query traffic, and
leaves families split by query hash that normalized text would have merged.

So `TextDescriptorKind` carries a version, and it feeds *both* the record kind and the logical kind
hashed into the record id. The id is what retires a record — `ReadJsonAsync` is keyed by id and
never looks at the kind — so restamping only the record kind leaves it readable, and a test that
restamps the kind to prove retirement passes against a broken implementation. Mint the legacy id
to test this, and mutate `Id(TextDescriptorKind, …)` back to the literal to confirm the guard binds.

Bump the stamp whenever the normalizer changes what it accepts or how it renders what it accepts,
and add the old value to `SupersededTextDescriptorKinds`. That list exists because retiring by id
makes the old records unreachable, and an unreachable record that no kind list names is storage
nothing can ever reclaim.

## Validation commands

```powershell
dotnet build SqlSimCity.slnx -c Release        # 0 warnings expected
dotnet test SqlSimCity.slnx -c Release         # 1,505 tests
npm test                                       # 647 probe-catalog tests
cd web; npm ci; npm run build; npm test -- --run   # 1,069 tests / 54 files
npm run typecheck
```

Those counts are the baselines to compare against. Investigate any delta rather than accepting it.

`npm run typecheck` and `npm run build` are not the same check. `typecheck` covers the app
sources; `build` runs `tsc -b` over the whole project graph, which is the first thing that reads
the `*.test.ts` files. A test that constructs a contract value with a string literal outside its
union type passes the suite — Vitest strips types — passes `typecheck`, and fails the build. Run
`npm run build` before pushing, not only at release time.

The root `npm test` is easy to miss because the web suite is the one usually meant by "the
frontend tests". It validates `sql/manifest.json` against the probe files, and it is what pins
the shape of the Query Store paging probes — a probe edit can leave both other suites green.

### The slow tests are isolated on purpose

Suite wall time is set by a few individual tests, not by the total, so the layout that spreads
them out is load-bearing and easy to undo by tidying.

The `cityGrowth` family is four spec files over one `cityGrowth.testkit.ts`, and
`cityGrowthRetrace.test.ts` holds exactly one test because that test alone is the web suite's
critical path — it was 17.7s of a 44s run. Vitest schedules a *file* onto a worker, so merging
these back into one spec re-serialises them and roughly doubles the suite. Add growth tests to
one of the other three; leave the retrace file alone.

The cost there is `planCity`, not the test scaffolding: measured over counts 80..140, planning is
16,150ms against 116ms of signature building. Nothing done in a test file will move it.

For the .NET side the rule is the same one `SeedUnrelatedRowsAsync` already illustrates. Seeding
through `SqliteProtectedRecordStore.PutAsync` costs 19–43ms per row, because the store sets
`Pooling = false` on purpose and every call therefore opens a connection and commits — an fsync
apiece. Batching a seed into one connection and one transaction gets the same rows in at ~8µs
each. Seed in bulk and reserve `PutAsync` for what is actually under test.

## Every pull request needs a `release:*` label

Merging to `main` with green CI cuts a release automatically (`.github/workflows/auto-release.yml`),
and the label on the pull request is what picks the version bump. There is no prompt and no second
chance: the tag is cut, the GitHub Release is written and the image is pushed to GHCR within a
couple of minutes of the merge.

Apply exactly one before merging. All four already exist, so use `gh pr create --label` or
`gh pr edit --add-label`:

| label | when |
|---|---|
| `release:major` | Anyone running the image must change something to stay working — a removed or renamed API route or response field, a renamed configuration key or environment variable, a changed default that alters behaviour, a database or archive format that old readers cannot open. |
| `release:minor` | New capability that costs the operator nothing — a new view, endpoint, opt-in setting or supported source. Nothing that worked before behaves differently. |
| `release:patch` | Bug fix, performance work, a rendering or layout correction, dependency bumps, refactors with no visible effect. |
| `release:skip` | Nothing reaches the shipped artifact: docs, `AGENTS.md`, tests, CI workflows, repository chores. Also the deliberate choice when batching a run of changes into one hand-cut release — see below. |

**The bump describes the promise to whoever runs the image, not the size of the diff.** A one-line
change that renames a config key is `major`. A thousand-line refactor that no operator can observe
is `patch`. Do not reach for the label by counting files.

When a pull request spans categories, take the highest one it earns. A feature that also removes an
old route is `major`, not `minor`.

Omitting the label is not neutral — it silently means `patch`, so feature work ships understated.
That is exactly how v0.7.0 came to need a hand-cut `workflow_dispatch`: #69, #70 and #71 all merged
unlabelled.

If a change genuinely should not ship on its own, prefer `release:skip` over leaving it bare, so the
intent is recorded rather than inferred.

### `release:skip` defers a bump, it does not cancel one

Skipping is also used deliberately to batch. Every release builds and pushes an image to GHCR,
which is far too slow to want on every pull request, so the working practice is to merge a run of
changes as `release:skip` and then cut one release by hand with `workflow_dispatch` covering
everything since the last one.

That moves an obligation rather than removing it. The skipped change still lands on `main`, so
**`release:skip` does not mean "no bump", it means "some later release carries this, and a decision
made elsewhere picks its size".**

When you cut that batched release, the bump is the **highest bump earned by any pull request merged
since the last release** — not the size of whichever one triggered it, and not the size of the
largest diff. Work out the label each merged pull request would have carried and take the maximum.

This is the same understatement failure as merging unlabelled, reached by a third route. #99 added
the operator-facing `LiveIncidents:SampleBounds` setting and was relabelled from `release:minor` to
`release:skip` shortly before merging, so it sits on `main` unreleased. Cut the next release as a
patch because the pull request prompting it happens to be a bug fix, and a minor-worthy capability
ships inside a patch.

So when a bump-worthy change is skipped, say so in the pull request body. Whoever cuts the batched
release can then find it without re-reading every diff since the last tag.

### Merge one pull request at a time, and wait for its release

This section is about pull requests that carry a bump label. When everything in flight is
`release:skip` there is no release to wait for and no collapse to cause, which is much of the time
under the batching practice above — but the moment one pull request carries a bump, the following
applies to it.

The label is only half of it. Auto-release triggers on **CI completing on `main`**, not on the
merge, and CI cancels a superseded in-progress run. So merging a second pull request before the
first one's run finishes cancels that run, and the release it would have cut never happens — the
commits still land, but one commit's label never gets read.

That is not hypothetical. #85 (`release:minor`) and #86 (`release:patch`) were merged 94 seconds
apart. #85's run on `main` was cancelled, only #86's reached the release job, and both shipped as
**v0.7.2** — a patch. The new `Atlas:QueryStoreRefreshIntervalSeconds` setting went out understated,
which is the same understatement failure as merging unlabelled, reached by a different route.

Whether that can be repaired afterwards depends on whether a release was actually cut. If one was,
it is stuck: the workflow declines to cut a second release for a commit that is already tagged,
deliberately, so the tag stays where the first release put it. That is the #85/#86 case, and the
only clean fix is not to cause it. If no release was cut at all — the ordinary batching case above,
or a collapse where the surviving run carried `release:skip` — then nothing is tagged and a
`workflow_dispatch` bump from `main`'s tip fixes it cleanly.

Wait for the release to appear before merging the next one. If several pull requests share a bump
class the collapse is harmless — the version lands in the right place either way — but confirm that
before relying on it, rather than after.

#### Merge the release-bearing pull request last

Ordering makes the wait unnecessary, which is worth having when the wait is the part that gets
skipped. The version job reads labels off the merged pull request for the head SHA of the run that
*completed*, and it tests `release:skip` first — that branch calls `no_release` and wins outright
over any bump. So the two collapse cases are not symmetric.

Merge a `release:skip` before a bump and the collapse costs nothing: the skip run is the one
cancelled, and it was never going to cut anything. The bump's run then reaches the release job and
tags a commit that already contains the skipped work.

Merge them the other way round and the collapse is worse than #85/#86. There the bump run is
cancelled and the *skip* run reaches the release job, which cuts **nothing at all** — no tag, no
release, and the bump's change ships silently inside whatever release comes along later. #85/#86 at
least produced a version, merely understated.

So when pull requests are ready together, merge every `release:skip` first and the release-bearing
one last. Between two bumps there is no safe order, only the wait.

This holds only while the two merges produce separate merge commits. The label read is an unordered
union over every merged pull request the API returns for one SHA, so anything that puts both behind
a single commit — merging one branch into the other before merging to `main`, or otherwise
collapsing the two — lets the skip suppress the bump, with no ordering left to get right. Ordinary
sequential merges never do this.

## Scratch files

One-off probe pages and ad-hoc measurement scaffolding do not get committed. Delete them and
confirm `git status` is clean before opening a pull request.

That is about throwaway scratch, not about tooling. `tools/measure/` is the opposite case: a
deliberate, documented workbench for measuring what a probe costs the instance it runs
against, kept precisely so the next measurement is reproducible rather than reinvented. Add
to it rather than growing a private copy beside it.
