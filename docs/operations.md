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

## Health and readiness

`GET /healthz` reports that the process is running. `GET /readyz` reports that
startup initialization, including protected-storage initialization when enabled,
completed. Both responses are deliberately generic. Container smoke coverage is:

```bash
tools/container-smoke.sh ghcr.io/cbattlegear/sqlsimcity@sha256:<digest>
```

The script binds an ephemeral loopback port, validates health, readiness, atlas,
live, Query Store status/query, and findings status/export contracts, then
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
the data. Confirm `/readyz`, then exercise Query Store status and findings export.
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
4. Wait for `/readyz`; then check atlas, Query Store, and findings status.
5. Keep the previous image digest and pre-upgrade backup until acceptance.

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
  'https://github.com/cbattlegear/SQLSimCity/.github/workflows/release.yml@refs/tags/<tag>' \
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

The release workflow publishes only owner-created `v*` tags through the
`release` environment. Repository administrators must configure that environment
with required independent reviewers, prevent self-review, and protect `v*` tag
creation before enabling releases. BuildKit emits maximum provenance and an SPDX
SBOM, GitHub records an artifact attestation, and cosign signs by digest with
GitHub OIDC. Release tags are attached only after those steps succeed, and there
is no long-lived signing key. A manual run defaults to a local, non-publishing
smoke build; manually publishing still requires a selected `v*` tag, the
repository owner, and environment approval.

Dependabot updates GitHub Actions, NuGet, web npm, and Docker references weekly.
Action references remain pinned to immutable commits; review the version comment
and upstream release notes when accepting an update.

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
