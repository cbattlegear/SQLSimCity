# Pre-removal format-1 archive

`format1-findings-before-removal.ssca` was generated on 2026-09-04 from the
**unmodified** exporter at commit `3aa32477db6fef830cd391f7726814416c9eb354`,
before removing Findings from the archive reader, exporter, or contracts:

```powershell
dotnet run --project src\SqlSimCity.Archive.Tool --no-restore -- export-fixture `
  --output tests\SqlSimCity.Archive.Tests\Fixtures\format1-findings-before-removal.ssca `
  --created-at 2025-01-02T03:04:05Z --display-alias legacy-fixture
```

- File length: **296,683 bytes**
- SHA-256: `5475d64784049c3609b0e395b1585dd775642df9025e3a9fece8e1399580ae68`
- Format: `1.0`; required feature: `findings-evidence-v1`
- `findings/descriptor.json`: 449 bytes, 15 rule versions,
  SHA-256 `963c1462d8d8acb891643f48e6daa9a8f30c2934bcc00b2c751b79b8175fac0d`
- `findings/snapshot.json`: 20,547 bytes, 7 exported findings,
  SHA-256 `37cb5d978ce2e48bea1a3149837ed4255f54057f36113166c608d155d7af213a`

The input was entirely the repository's synthetic fixture sources. No database,
operator data, credentials, or network acquisition was used. The default
`sqlsimcity-default-v1` redaction omits protected identifiers, raw SQL, and raw
Showplan XML. The older `created-at` intentionally differs from fixture observation
times: these clocks were independently configurable in the original tool.

Keep these exact bytes. Compatibility tests consume this checked-in artifact,
not a freshly generated replacement, and separately check its real Findings
feature, descriptor, and snapshot before testing retained atlas, capabilities,
Query Store, plans, database-city, and static live evidence.
