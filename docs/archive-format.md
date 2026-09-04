# SQLSimCity observation archive format

## Purpose and compatibility

An `.ssca` file is a redacted, point-in-time SQLSimCity observation export for offline analysis. It
is not a backup of protected storage and cannot restore collection state or credentials.
Readers accept format major version `1`; an unsupported major version fails startup. Minor-version
additions require an explicitly declared feature understood by the reader.

## Byte layout

All integers in the container header are unsigned conceptual lengths, bounded by the reader:

```text
8 bytes   magic: 53 53 43 41 0d 0a 1a 0a ("SSCA\r\n\x1a\n")
4 bytes   big-endian canonical-manifest byte length
N bytes   RFC 8259 JSON manifest in canonical form
...       entry bytes concatenated in manifest order
EOF       exact; trailing bytes are rejected
```

The format deliberately has no compression, extraction, external references, XML, plugins, scripts,
or executable content. This removes archive path extraction, zip/tar bomb, decompression-ratio, XXE,
and parser-selection ambiguity from the trust boundary.

Canonical JSON is UTF-8 without a BOM, comments, insignificant whitespace, or trailing commas.
Object property names are sorted by ordinal UTF-16 name order; array order is significant; numbers
retain their JSON lexeme. SHA-256 is lowercase hexadecimal over the exact entry bytes. Big integers
and exact decimal evidence are JSON strings and remain byte-for-byte strings throughout a
round-trip. The manifest itself is canonicalized before writing and a reader rejects a semantically
equivalent but noncanonical encoding.

## Manifest

The versioned manifest records:

- `schemaVersion`, `producerVersion`, and UTC `createdAt`;
- target `opaqueIdentity` and operator-safe `displayAlias`;
- ordinally sorted `includedSections`;
- every entry's safe relative `name`, section, content type, byte length, SHA-256 digest, record
  count, source observation/freshness timestamps, reset epoch, and retention resolution;
- the redaction policy and whether protected identifiers were explicitly included;
- required format features and source capabilities;
- export bounds for bytes, entries, records, names, and execution time.

Entry names are manifest identifiers only. The reader never joins them to the filesystem. Names are
unique, ASCII-lowercase safe paths with no backslashes, absolute roots, drive roots, or `..`.

## Sections

Version 1 supports independently optional capability, Query Store, database-city, and live
sections around the required atlas snapshot:

| Section | Contents |
|---|---|
| `atlas` | Snapshot and collector status with original evidence timestamps |
| `capabilities` | Source-neutral negotiated capability snapshot |
| `query-store` | Collector status, bounded metric/database page chunks, family index, family detail chunks, normalized-plan chunks |
| `database-city` | Summary snapshot and bounded page index/chunks |
| `live` | At most one latest imported point-in-time response |

Query Store family details and normalized plans remain separate indexed chunks. API requests read
only the chunks needed for one bounded page or selected family/plan; neither the browser nor the API
materializes every family detail.

Database-city pages carry an optional `queryStoreDatabaseId` binding separately from their full
`databaseId` owner identity. Both use database identifier redaction, so a proven binding stays equal
to the captured Query Store families' database IDs through export and import. Explicit `null` remains
null and disables the plan finder; no binding is inferred from a display name or database-name
suffix. For older pages without the field, the shared namespace resolver requires one consistent
namespace proved by exact captured `TopQueryFamilies.FamilyId` matches or by an exact full owner-ID
match to a captured query family's database ID. The owner must uniquely identify a database in both
atlas and city summaries, and no other full city owner may claim that namespace. Otherwise the reader
publishes explicit null. This check uses identically redacted identities captured during startup
validation, not a new family scan per page request. It never revives an explicit null or binds cities
merely because their database names match.

New exports contain no Findings section, payload, descriptor, `findings-evidence-v1` feature, or
`offline-findings-reevaluation` capability. Findings are no longer displayed or reevaluated.

Older format-1 archives declaring `findings-evidence-v1` remain readable for their retained evidence.
The reader validates the legacy snapshot and descriptor using private, read-only compatibility types,
then discards them. They are not part of the public archive API. The feature, snapshot, and descriptor
must appear together; their sections, engine/rule versions, and record counts must agree. Unknown
fields, missing required fields, null required records, invalid enums, and malformed JSON are rejected.
The same byte/record/depth bounds, canonical encoding, and digest checks apply to legacy entries;
unknown required features still reject the whole archive before publication. Archive information
omits the retired Findings section, feature, descriptor, and reevaluation capability, even when
they were declared by the old producer.

The independently pinned [pre-removal fixture](../tests/SqlSimCity.Archive.Tests/Fixtures/README.md)
documents provenance and verifies this compatibility without relying on the current exporter.

## Privacy and redaction

The default `sqlsimcity-default-v1` policy excludes SQL credentials, authentication identifiers,
raw SQL, raw Showplan XML, host/login/program/client addresses, secret paths, and
database/schema/object/index names. Literal-safe normalized SQL may only originate from the existing
ScriptDom normalization path; default fixture export omits even normalized text and retains its
fingerprint. A parse/redaction failure must omit or fingerprint text, never pass raw text through.
`--protected-identifiers` is an explicit local operator opt-in for already normalized text and
protected identifiers; it never enables raw SQL or raw Showplan XML.
Reset-epoch equality and boundaries are preserved. Because connected Query Store epoch tokens can
embed a database identifier, the default policy replaces those token values with stable
`reset-epoch-*` pseudonyms; `--protected-identifiers` retains their exact original strings.

## Export and validation

Preview performs all collection, redaction, canonicalization, hashing, indexing, and bound checks but
does not write:

```powershell
dotnet run --project src\SqlSimCity.Archive.Tool -- preview-fixture
```

Export prints the same manifest before atomically replacing a temporary file with the final file.
Existing output is refused unless `--overwrite` is explicit. Unix output permissions are user
read/write only where supported.

```powershell
dotnet run --project src\SqlSimCity.Archive.Tool -- export-fixture `
  --output C:\archives\sqlsimcity.ssca
dotnet run --project src\SqlSimCity.Archive.Tool -- validate `
  C:\archives\sqlsimcity.ssca
dotnet run --project src\SqlSimCity.Archive.Tool -- smoke-import `
  C:\archives\sqlsimcity.ssca
```

The standalone tool distribution includes the repository `LICENSE` and `NOTICE`.

## Offline import

Configure one simple filename under an allowed directory:

```json
{
  "Acquisition": {
    "Mode": "Archive",
    "Archive": {
      "AllowedDirectory": "/archives",
      "FileName": "sqlsimcity.ssca",
      "MaximumArchiveBytes": 268435456
    }
  }
}
```

Mount `/archives/sqlsimcity.ssca` read-only. Startup opens that regular file, rejects symlinks and
special files, validates the entire manifest and every digest/index before building the app, and
publishes nothing on failure. Archive mode makes no archive-controlled write or network call. Atlas
and the Archive panel label the source `ImportedArchive`; the original timestamps and freshness
remain visible. The imported live sample is always static/stale, with a stopped collector and no
SignalR hub or polling loop.

## Retention and limitations

Retention resolution and reset epochs describe the exported evidence; import does not extend
retention, freshness, or reset epochs. Missing optional sections remain explicitly unavailable.
Archives are unsigned in format version 1: SHA-256 detects corruption and manifest mismatch but does
not establish who produced a file. Transfer archives through an authenticated channel and apply
filesystem access controls. The shipped CLI currently exports deterministic fixture evidence for CI;
connected/protected-storage export orchestration remains a post-MVP deployment integration.
