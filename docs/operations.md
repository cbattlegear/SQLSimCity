# Operations

SQLSimCity's supported production host is a Linux container host on `linux/amd64`
or `linux/arm64`. The operational scripts require Bash, GNU tar, GNU coreutils,
gzip, and findutils. Run the service on loopback or behind an authenticating
reverse proxy on a trusted network; the application has no authentication and
must not be exposed directly to the internet.

The shipped `appsettings.json` pins `AllowedHosts` to `localhost;127.0.0.1;[::1]`;
this is a `Host` header check, not an exposure control, and loopback binding
remains the actual network boundary. When using a reverse proxy, terminate
TLS and enforce authentication there, restrict the backend network path, and set
`AllowedHosts` to the externally accepted host names (semicolon-separated in
ASP.NET Core configuration). Keep a loopback entry in that list if you also run
`tools/container-smoke.sh`, which connects over loopback. A proxy must forward
WebSocket upgrades for `/hubs/current-snapshot`, or the UI silently falls back to
polling for live incidents.

## Forwarded client addresses

By default SQLSimCity ignores `X-Forwarded-For` and `X-Forwarded-Proto`, so every
request behind a proxy is attributed to the proxy's own address. The API rate
limit (`HttpSecurity:ApiPermitLimit`, 600 requests per 60 seconds) then applies to
all clients together rather than to each one, and one noisy client can exhaust it
for everybody.

To restore per-client partitioning, name the peers whose forwarded headers may be
believed:

```yaml
ReverseProxy__Enabled: "true"
ReverseProxy__KnownProxies: "172.18.0.9"
# or, for a whole bridge network:
# ReverseProxy__KnownNetworks: "172.18.0.0/16"
```

Both accept semicolon- or comma-separated values. The address to list is the peer
address SQLSimCity actually sees, which behind Docker is the gateway or the proxy
container's address, not the browser's. `ReverseProxy__ForwardLimit` (default 1)
is how many trusted hops the request passes through.

Enabling this without naming a peer stops startup rather than trusting everyone.
`X-Forwarded-For` is client-supplied text, so an unrestricted allowlist would let
anyone who can reach the port name their own address and take a private rate-limit
bucket per request — worse than the shared bucket the setting exists to fix. When
a request arrives with `X-Forwarded-For` from a peer that is not listed, the header
is ignored and the process logs `ForwardedHeadersFromUntrustedPeer` once, naming
the address it saw, so a misconfigured allowlist cannot pass for a working one.

`X-Forwarded-Host` is never honoured: `AllowedHosts` filters on the request host,
and letting a header rewrite the value that check reads would weaken a control
configured separately. Pass the real `Host` from the proxy instead. Note that once
this is enabled, recorded client addresses are asserted by the proxy rather than
observed by this process.

## Link previews

Every page is served with a document head describing what that link opens: the
title is `SQL Sim City` at the root and `SQL Sim City - <database>` for a city
link, and the preview image is a skyline drawn from the same measurements the map
uses — one tower per database on the atlas card, one per object on a city card.
Databases nothing has measured get a fenced empty plot rather than a short tower,
so the count in the corner always matches the number of plots in the picture.

The card is served from `/social-card.png`, optionally with `?database=<name>`. It
is a `GET`-only route like everything else here, it reads only the snapshot the API
already holds, and it is rendered at most once per database per UTC day and then
cached in memory. There is no new outbound traffic and nothing is written to disk.

**Behind a reverse proxy, set `ReverseProxy__Enabled` and name the peer.** The
absolute URLs in `og:image` and `og:url` are built from the request scheme and
host. `X-Forwarded-Proto` is ignored unless the proxy is trusted, so a site
terminating TLS at the proxy will otherwise advertise `http://` image URLs, and
the clients that fetch preview images generally will not follow that from an
`https://` page — the preview arrives with no picture. The section above is the
same setting; this is a second reason to configure it.

Preview clients cache aggressively and by URL. After an upgrade that changes the
card, expect existing links to keep showing the old image until the client's own
cache expires; posting the link with a changed query string is the usual way to
force a re-fetch while testing.

## Health and readiness

`GET /healthz` reports that the process is running. `GET /readyz` reports that
startup initialization, including protected-storage initialization when enabled,
completed. Both responses are deliberately generic. Container smoke coverage is:

```bash
tools/container-smoke.sh ghcr.io/cbattlegear/sqlsimcity@sha256:<digest>
```

The script binds an ephemeral loopback port, validates health, readiness, atlas,
live, capabilities, database-city, and Query Store status/query contracts, plus the JSON `410 Gone`
responses from retired Findings routes, then
removes only the exact containers it created. It also proves that connected
Query Store history without protected storage exits nonzero.

## Backup and tested restore

Stop the application before a backup, or stop/quiesce the container so SQLite
has no writer. `--quiesced` is an explicit operator assertion; the script cannot
prove another process is not writing.

```bash
tools/backup-data.sh --quiesced \
  /var/lib/sqlsimcity/data /backups/sqlsimcity-data-v1.tar.gz
```

The backup is written atomically to a new filename (existing archives are never
overwritten), contains a versioned manifest and checksummed payload, and rejects
symlinks and unsafe paths. There is no key to exclude or store separately: a
backup of the data directory is everything needed to restore. That also makes the
backup itself sensitive — it holds captured query text and plan XML in the clear,
so protect it like the data volume.

Restore only while the application is stopped and only into an existing, empty
directory:

```bash
tools/restore-data.sh \
  --quiesced \
  /backups/sqlsimcity-data-v1.tar.gz /var/lib/sqlsimcity/data
```

The restore validates wrapper paths, manifest version, checksum, payload paths,
and file types before writing to the still-empty target. Run it as the target
owner/group or as root; root restores assign the target's existing owner/group
to the restored tree. After restoring, start the exact image version that created
the data. Confirm `/readyz`, then exercise Query Store status and query history.
The CI operations test performs a deterministic backup/restore round trip and
negative tests for symlinks, traversal, non-empty targets, and tampering. Paths
that the restore format cannot represent safely are rejected at backup time.

## Starting the store over

Query Store history is a cache the collector rebuilds from SQL Server, not a
system of record, so discarding it costs one collection interval. Stop the app
and delete the database and its sidecars from the data directory:

```bash
rm -f /var/lib/sqlsimcity/data/protected-storage.db \
      /var/lib/sqlsimcity/data/protected-storage.db-wal \
      /var/lib/sqlsimcity/data/protected-storage.db-shm
```

Delete all three. A `-wal` or `-shm` left beside a deleted database yields a
store that fails its canary check on the next start. A store written by a version
that encrypted payloads must be discarded this way — this version has no key and
cannot open it, and says so at startup rather than serving nothing.

## Upgrade and rollback

1. Back up `/data` and test the restore.
2. Resolve the release image to a digest and record the current digest.
3. Review release notes and deploy the new digest with the existing read-only,
   capability-drop, and no-new-privileges settings.
4. Wait for `/readyz`; then check atlas, capabilities, and Query Store status.
5. Keep the previous image digest and pre-upgrade backup until acceptance.

The next major release removes Findings: migrate clients and monitoring away from
`/api/v1/findings` and all its descendants, which now return JSON `410 Gone`. Use atlas,
capabilities, Query Store, database-city, and live evidence directly; there is no replacement
assessment engine. New archives omit Findings. Existing format-1 archives are still accepted
after full legacy-section validation, but their Findings content is not evaluated or exposed.
No archive conversion or protected-store reset is required for this removal.

Step 3 is not only a formality. A configuration key that is *removed* rather than
renamed-with-a-fallback stops startup by design, so an upgrade can fail on a
setting the old image accepted happily. Upgrading to **1.0.0** from any `0.x` is
the case in force today: the five `QueryStoreHistory` day/hour keys were replaced
by hour/minute equivalents and the old names are now rejected by name. Check the
deployment's environment against the table in
[connected mode](connected-mode.md) before deploying, since a container that
carries one will not reach `/readyz` at step 4.

Protected-storage schema migrations run fail-closed at startup. No backward
migration is promised. Rolling back may require restoring a data backup that is
compatible with the older image; do not point an older image at data already
migrated by a newer version unless that compatibility is explicitly documented.

## Verify a release

Pin deployments by the published manifest digest, never a mutable tag:

```bash
docker pull ghcr.io/cbattlegear/sqlsimcity@sha256:<digest>
gh attestation verify \
  oci://ghcr.io/cbattlegear/sqlsimcity@sha256:<digest> \
  --repo cbattlegear/SQLSimCity
cosign verify \
  --certificate-identity \
  'https://github.com/cbattlegear/SQLSimCity/.github/workflows/release.yml@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/cbattlegear/sqlsimcity@sha256:<digest>
docker buildx imagetools inspect \
  ghcr.io/cbattlegear/sqlsimcity@sha256:<digest> \
  --format '{{ json .Provenance }}'
docker buildx imagetools inspect \
  ghcr.io/cbattlegear/sqlsimcity@sha256:<digest> \
  --format '{{ json .SBOM }}'
cosign download sbom \
  ghcr.io/cbattlegear/sqlsimcity@sha256:<digest> > sqlsimcity.spdx.json
```

The signing identity depends on how the release was cut, and it is the same
workflow file either way. Signing happens inside `release.yml`, and the Fulcio
certificate's subject is the OIDC `job_workflow_ref` claim — the workflow that
*runs* the job, not the one that called it. So:

- an **automatic** release, where `auto-release.yml` calls `release.yml` as a
  reusable workflow from `main`, signs as
  `.../.github/workflows/release.yml@refs/heads/main`;
- a **hand-cut** `v*` tag push, where `release.yml` is itself the entry point,
  signs as `.../.github/workflows/release.yml@refs/tags/<tag>`, exactly as before.

Use whichever matches the release you are verifying. To accept both without
loosening the issuer or the repository, match the ref instead of pinning it:

```bash
cosign verify \
  --certificate-identity-regexp \
  '^https://github\.com/cbattlegear/SQLSimCity/\.github/workflows/release\.yml@refs/(heads/main|tags/v.+)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/cbattlegear/sqlsimcity@sha256:<digest>
```

The release workflow publishes only owner-initiated releases through the
`release` environment — either a `v*` tag the owner pushed, or a tag cut for them
by `auto-release.yml` on a merge they made (see "Cut a release" below).
Repository administrators must configure that environment
with required independent reviewers, prevent self-review, and protect `v*` tag
creation before enabling releases. BuildKit emits maximum provenance and an SPDX
SBOM, GitHub records an artifact attestation, and cosign signs by digest with
GitHub OIDC. Release tags are attached only after those steps succeed, and there
is no long-lived signing key. A manual run of `release.yml` defaults to a local,
non-publishing smoke build; manually publishing that way still requires a selected
`v*` tag, the repository owner, and environment approval.

Dependabot updates GitHub Actions, NuGet, web npm, and Docker references weekly.
Action references remain pinned to immutable commits; review the version comment
and upstream release notes when accepting an update.

## Cut a release

Merging a pull request into `main` cuts a release automatically once CI passes.
`auto-release.yml` waits for the `CI` workflow to finish successfully on `main`
— `release.yml`'s own verify job builds and smokes the image but does not run the
.NET or web suites, so gating on CI is what stops an image being published for a
commit whose tests failed — then reads the merged pull request's labels to decide
the version bump:

| Label | Bump | Example from `1.4.2` |
| --- | --- | --- |
| `release:major` | major | `2.0.0` |
| `release:minor` | minor | `1.5.0` |
| `release:patch` | patch | `1.4.3` |
| _none_ | patch | `1.4.3` |
| `release:skip` | none | no release |

The base is the highest existing stable `v*` tag; prereleases are ignored so a
`v1.5.0-rc.1` never becomes the base for the next bump. The labels must exist on
the repository before they can be applied:

```bash
gh label create release:major --description 'Release: bump the major version' --color B60205
gh label create release:minor --description 'Release: bump the minor version' --color 0E8A16
gh label create release:patch --description 'Release: bump the patch version' --color 1D76DB
gh label create release:skip  --description 'Release: do not cut a release for this merge' --color 6A737D
```

Two cases deliberately do **not** release: a direct push to `main` with no merged
pull request, and a merge by anyone other than the repository owner. The second
mirrors the publish gate in `release.yml`; declining before the tag is cut is what
stops a tag and a GitHub Release existing for an image that was never published.
Cut either by hand with the `Auto release` workflow's `workflow_dispatch`, which
takes an explicit version or a bump, or by pushing a `v*` tag yourself — the tag
path runs `release.yml` directly and is unchanged.

### Published image tags

Each release publishes, all pointing at the same signed manifest digest:

- `X.Y.Z` — immutable, and the only one that names one specific release;
- `X.Y` and `X` — floating, moved to the newest matching release. `X` is only
  published from `1.0.0` onward, because a bare `0` spanning every unstable `0.x`
  release would say nothing useful;
- `latest` — floating, moved to the newest stable release;
- `sha-<commit>` — the commit the image was built from.

Prereleases (`1.0.0-rc.1`) publish only their exact version and commit tags; they
never move `X.Y`, `X` or `latest`.

Floating tags exist for convenience only. **Deploy by digest**, as the upgrade and
verification steps above require — a moving tag defeats both the rollback plan and
the signature check.

## NuGet lock files

Package versions live in `Directory.Packages.props` (Central Package Management)
and every project carries a `packages.lock.json`. CI restores with
`--locked-mode`, so a restore fails rather than silently resolving a version that
is not in the lock files.

A consequence is that changing one version in `Directory.Packages.props`
invalidates the lock file of every project holding a matching transitive or
`CentralTransitive` entry, including projects nobody edited. Restore then stops
with `NU1004`. The fix is always the same:

```bash
dotnet restore SqlSimCity.slnx --force-evaluate
git add -- "**/packages.lock.json"
git commit -m "Regenerate NuGet lock files"
```

CI detects this specific failure and prints those commands in the job summary.

### Automatic synchronization on Dependabot pull requests

Dependabot regenerates only the lock files it considers directly affected, so its
NuGet pull requests hit `NU1004` on the rest.
`.github/workflows/dependabot-lockfiles.yml` closes that gap: on a NuGet
Dependabot pull request it verifies the diff touches nothing but
`Directory.Packages.props` and `packages.lock.json` files, runs
`--force-evaluate`, and pushes the regenerated lock files back to the branch. It
no-ops when the lock files are already in sync, and never runs for the npm,
Docker, or GitHub Actions ecosystems.

Pushing requires a credential that is not `GITHUB_TOKEN`, because Dependabot
runs receive a read-only token and because pushes made with `GITHUB_TOKEN` do not
re-trigger CI. To enable the workflow:

1. Create a GitHub App owned by the repository owner whose only repository
   permission is **Contents: Read and write**, and install it on this repository
   alone.
2. Store its App ID and a generated private key as **Dependabot** secrets
   (Settings → Secrets and variables → **Dependabot**) named
   `LOCKFILE_SYNC_APP_ID` and `LOCKFILE_SYNC_PRIVATE_KEY`.

They must be Dependabot secrets. Actions secrets are not visible to
Dependabot-triggered runs. Until they exist the workflow still runs, detects the
drift, and writes the manual fix into the job summary instead of pushing.
