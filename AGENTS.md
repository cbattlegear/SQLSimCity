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

## Validation commands

```powershell
dotnet build SqlSimCity.slnx -c Release        # 0 warnings expected
dotnet test SqlSimCity.slnx -c Release         # 1,144 tests
cd web; npm ci; npm run build; npm test -- --run   # 753 tests / 41 files
npm run typecheck
```

Those counts are the baselines to compare against. Investigate any delta rather than accepting it.

## Scratch files

Probe pages and measurement scaffolding do not get committed. Delete them and confirm
`git status` is clean before opening a pull request.
