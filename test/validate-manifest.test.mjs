// Validation for the sql/ probe catalog.
//
// This suite is dependency-free (built-in node:test + node:assert only) and:
//   1. Unit-tests the sqlGuard library directly against synthetic strings (true positive/negative
//      cases), so the guard logic itself is proven correct rather than assumed.
//   2. Loads sql/manifest.json and checks structural completeness.
//   3. For every manifest entry, loads its referenced .sql file and checks: the file exists,
//      declared parameters exactly match the parameters actually referenced in the file, no
//      forbidden mutating/dynamic-SQL tokens appear, a SELECT/CTE result path exists, and
//      version-variant probes carry explicit version-applicability text.
//   4. Confirms every .sql file under sql/probes/ is referenced by exactly one manifest entry.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  stripSqlComments,
  extractParameterNames,
  findForbiddenTokens,
  hasSelectResultPath,
  splitStatements,
} from './lib/sqlGuard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const sqlDir = path.join(repoRoot, 'sql');
const manifestPath = path.join(sqlDir, 'manifest.json');

function loadManifest() {
  const raw = readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw);
}

function listSqlFilesRecursive(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...listSqlFilesRecursive(full));
    } else if (entry.endsWith('.sql')) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 1. Unit tests for the guard library itself (synthetic strings, not real probe files).
// ---------------------------------------------------------------------------

describe('sqlGuard: stripSqlComments', () => {
  test('removes line comments', () => {
    const out = stripSqlComments('SELECT 1 -- trailing comment\nFROM t');
    assert.ok(!out.includes('trailing comment'));
    assert.ok(out.includes('SELECT 1'));
    assert.ok(out.includes('FROM t'));
  });

  test('removes block comments spanning multiple lines', () => {
    const out = stripSqlComments('SELECT 1 /* block\ncomment\nspanning lines */ FROM t');
    assert.ok(!out.includes('block'));
    assert.ok(!out.includes('spanning'));
    assert.ok(out.includes('SELECT 1'));
    assert.ok(out.includes('FROM t'));
  });

  test('does not strip -- inside a string literal', () => {
    const out = stripSqlComments("SELECT 'a--b' AS x");
    assert.ok(out.includes("'a--b'"), 'string literal content must survive comment stripping');
  });

  test('handles escaped quotes inside string literals', () => {
    const out = stripSqlComments("SELECT 'it''s -- not a comment' AS x FROM t");
    assert.ok(out.includes('FROM t'));
    assert.ok(out.includes("it''s -- not a comment"));
  });
});

describe('sqlGuard: extractParameterNames', () => {
  test('extracts simple named parameters', () => {
    const names = extractParameterNames('SELECT * FROM t WHERE a = @Foo AND b = @Bar');
    assert.deepEqual([...names].sort(), ['@Bar', '@Foo']);
  });

  test('excludes system/session variables (@@ prefix)', () => {
    const names = extractParameterNames('SELECT @@VERSION, @@ROWCOUNT, @Real');
    assert.deepEqual([...names], ['@Real']);
  });

  test('deduplicates repeated references', () => {
    const names = extractParameterNames('WHERE a = @X OR b = @X OR c = @X');
    assert.deepEqual([...names], ['@X']);
  });

  test('ignores parameters mentioned only in comments', () => {
    const names = extractParameterNames('-- uses @NotReal in a comment\nSELECT 1');
    assert.deepEqual([...names], []);
  });
});

describe('sqlGuard: findForbiddenTokens', () => {
  const forbiddenExamples = [
    ['ALTER DATABASE x SET QUERY_STORE = OFF', 'ALTER statement'],
    ['DBCC FREEPROCCACHE', 'DBCC command'],
    ['EXEC sp_who', 'EXEC/EXECUTE statement'],
    ['EXECUTE sp_who', 'EXEC/EXECUTE statement'],
    ["INSERT INTO t VALUES (1)", 'INSERT statement'],
    ['UPDATE t SET a = 1', 'UPDATE statement'],
    ['DELETE FROM t', 'DELETE statement'],
    ['MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN UPDATE SET a=1', 'MERGE statement'],
    ['TRUNCATE TABLE t', 'TRUNCATE statement'],
    ['CREATE TABLE t (a INT)', 'CREATE statement'],
    ['DROP TABLE t', 'DROP statement'],
    ['GRANT SELECT ON t TO u', 'GRANT statement'],
    ['DENY SELECT ON t TO u', 'DENY statement'],
    ['REVOKE SELECT ON t FROM u', 'REVOKE statement'],
    ['USE msdb', 'USE statement'],
    ["EXEC sp_executesql N'SELECT 1'", 'sp_executesql (dynamic SQL)'],
    ["SELECT * FROM OPENROWSET('SQLNCLI', 'a', 'b')", 'OPENROWSET/OPENQUERY/OPENDATASOURCE'],
    ['EXEC sp_query_store_force_plan 1, 2', 'Query Store administrative procedure'],
    ['ALTER DATABASE x SET QUERY_STORE CLEAR', 'Query Store CLEAR/force/flush maintenance'],
    ['EXEC master..xp_cmdshell \'dir\'', 'xp_cmdshell'],
  ];

  for (const [sql, expectedName] of forbiddenExamples) {
    test(`flags: ${expectedName}`, () => {
      const hits = findForbiddenTokens(sql);
      assert.ok(hits.includes(expectedName), `expected [${hits}] to include '${expectedName}'`);
    });
  }

  test('does not flag a plain read-only SELECT', () => {
    const sql = `
      SET NOCOUNT ON;
      SELECT s.session_id, s.status
      FROM sys.dm_exec_sessions AS s
      WHERE s.is_user_process = 1;
    `;
    assert.deepEqual(findForbiddenTokens(sql), []);
  });

  test('does not false-positive on words that merely contain a forbidden token', () => {
    // "execution_count", "created_at" (hypothetical alias) and "database_id" must not trip
    // EXEC/CREATE/USE just because the raw substring appears inside a longer identifier.
    const sql = `
      SELECT execution_count, count_executions, database_id, capture_policy_execution_count
      FROM sys.query_store_runtime_stats;
    `;
    assert.deepEqual(findForbiddenTokens(sql), []);
  });

  test('does not flag a forbidden keyword that only appears inside a comment', () => {
    const sql = '-- DROP TABLE would be forbidden if uncommented\nSELECT 1';
    assert.deepEqual(findForbiddenTokens(sql), []);
  });

  test('flags SELECT ... INTO #temp FROM ... (creates a table)', () => {
    const hits = findForbiddenTokens('SELECT session_id, status INTO #snap FROM sys.dm_exec_sessions;');
    assert.ok(hits.includes('SELECT INTO (creates a table)'));
  });

  test('flags SELECT ... INTO with no FROM clause at all', () => {
    const hits = findForbiddenTokens('SELECT 1 AS x INTO #t;');
    assert.ok(hits.includes('SELECT INTO (creates a table)'));
  });

  test('flags a later statement\'s SELECT ... INTO even after an earlier statement has its own FROM', () => {
    const sql = 'SELECT a FROM t; SELECT b INTO x FROM y;';
    const hits = findForbiddenTokens(sql);
    assert.ok(
      hits.includes('SELECT INTO (creates a table)'),
      'an earlier, unrelated FROM must not hide a later SELECT ... INTO in the same file',
    );
  });

  test('does not false-positive on an identifier merely containing "into" as a substring', () => {
    const sql = `
      SELECT session_id, migrated_into_pool, session_into_pool
      FROM sys.dm_exec_sessions;
    `;
    assert.deepEqual(findForbiddenTokens(sql), []);
  });

  test('does not false-positive on an ordinary SELECT ... FROM with no INTO', () => {
    const sql = `
      SELECT s.session_id, s.status
      FROM sys.dm_exec_sessions AS s;
    `;
    assert.deepEqual(findForbiddenTokens(sql), []);
  });
});

describe('sqlGuard: hasSelectResultPath', () => {
  test('accepts SET + SELECT', () => {
    const result = hasSelectResultPath('SET NOCOUNT ON; SELECT 1;');
    assert.equal(result.ok, true);
  });

  test('rejects undocumented SET options', () => {
    const result = hasSelectResultPath('SET XACT_ABORT ON; SELECT 1;');
    assert.equal(result.ok, false);
    assert.match(result.reason, /unsafe SET/);
  });

  test('accepts a leading CTE (WITH ... SELECT)', () => {
    const result = hasSelectResultPath('SET NOCOUNT ON; WITH c AS (SELECT 1 AS a) SELECT a FROM c;');
    assert.equal(result.ok, true);
  });

  test('accepts multiple independent SELECT result sets', () => {
    const result = hasSelectResultPath('SET NOCOUNT ON; SELECT 1; SELECT 2;');
    assert.equal(result.ok, true);
  });

  test('rejects a file with only SET statements and no SELECT', () => {
    const result = hasSelectResultPath('SET NOCOUNT ON; SET LOCK_TIMEOUT 5000;');
    assert.equal(result.ok, false);
  });

  test('rejects a non-SELECT top-level statement', () => {
    const result = hasSelectResultPath('SET NOCOUNT ON; UPDATE t SET a = 1;');
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// 2. Manifest structural checks.
// ---------------------------------------------------------------------------

const manifest = loadManifest();

describe('manifest.json structure', () => {
  test('parses and has a manifestVersion', () => {
    assert.equal(typeof manifest.manifestVersion, 'number');
  });

  test('has at least one probe', () => {
    assert.ok(Array.isArray(manifest.probes));
    assert.ok(manifest.probes.length > 0);
  });

  test('every probe has required fields', () => {
    const requiredFields = [
      'id',
      'title',
      'file',
      'connectionScope',
      'minPlatform',
      'azureSqlDatabase',
      'requiredPermission',
      'cadenceClass',
      'parameters',
      'resultSets',
      'resultContract',
      'relativeCost',
    ];
    for (const probe of manifest.probes) {
      for (const field of requiredFields) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(probe, field),
          `probe '${probe.id ?? '<unknown>'}' is missing field '${field}'`,
        );
      }
    }
  });

  test('probe ids are unique', () => {
    const ids = manifest.probes.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate probe id found');
  });

  test('probe files are unique (one probe per file)', () => {
    const files = manifest.probes.map((p) => p.file);
    assert.equal(new Set(files).size, files.length, 'duplicate probe file reference found');
  });

  test('connectionScope is one of the documented scopes', () => {
    const validScopes = new Set(Object.keys(manifest.connectionScopes));
    for (const probe of manifest.probes) {
      assert.ok(
        validScopes.has(probe.connectionScope),
        `probe '${probe.id}' has undocumented connectionScope '${probe.connectionScope}'`,
      );
    }
  });

  test('cadenceClass is one of the documented classes', () => {
    const validClasses = new Set(Object.keys(manifest.cadenceClasses));
    for (const probe of manifest.probes) {
      assert.ok(
        validClasses.has(probe.cadenceClass),
        `probe '${probe.id}' has undocumented cadenceClass '${probe.cadenceClass}'`,
      );
    }
  });

  test('relativeCost is one of the documented costs', () => {
    const validCosts = new Set(Object.keys(manifest.relativeCosts));
    for (const probe of manifest.probes) {
      assert.ok(
        validCosts.has(probe.relativeCost),
        `probe '${probe.id}' has undocumented relativeCost '${probe.relativeCost}'`,
      );
    }
  });

  test('azureSqlDatabase.unsupported is boolean with notes', () => {
    for (const probe of manifest.probes) {
      assert.equal(typeof probe.azureSqlDatabase.unsupported, 'boolean', `probe '${probe.id}'`);
      assert.equal(typeof probe.azureSqlDatabase.notes, 'string', `probe '${probe.id}'`);
      assert.ok(probe.azureSqlDatabase.notes.length > 0, `probe '${probe.id}' has empty Azure SQL DB notes`);
    }
  });

  test('every parameter declares name, sqlDbType, required, and description', () => {
    for (const probe of manifest.probes) {
      for (const param of probe.parameters) {
        assert.match(param.name, /^@[A-Za-z_][A-Za-z0-9_]*$/, `probe '${probe.id}' parameter name`);
        assert.equal(typeof param.sqlDbType, 'string', `probe '${probe.id}' param '${param.name}' sqlDbType`);
        assert.equal(typeof param.required, 'boolean', `probe '${probe.id}' param '${param.name}' required`);
        assert.equal(typeof param.description, 'string', `probe '${probe.id}' param '${param.name}' description`);
        assert.ok(param.description.length > 0, `probe '${probe.id}' param '${param.name}' has empty description`);
        if (param.required === false) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(param, 'default'),
            `probe '${probe.id}' optional param '${param.name}' must declare a default`,
          );
        }
      }
    }
  });

  test('version-variant probes declare versionVariantNotes', () => {
    for (const probe of manifest.probes) {
      if (Object.prototype.hasOwnProperty.call(probe, 'versionVariantOf')) {
        assert.equal(
          typeof probe.versionVariantNotes,
          'string',
          `probe '${probe.id}' declares versionVariantOf but no versionVariantNotes`,
        );
        assert.ok(probe.versionVariantNotes.length > 0, `probe '${probe.id}' has empty versionVariantNotes`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Per-probe file checks: existence, parameter matching, forbidden tokens, SELECT path,
//    version-variant header text.
// ---------------------------------------------------------------------------

describe('every manifest probe file', () => {
  for (const probe of manifest.probes) {
    describe(`${probe.id} (${probe.file})`, () => {
      const filePath = path.join(sqlDir, probe.file);

      test('file exists under sql/', () => {
        assert.ok(statSync(filePath, { throwIfNoEntry: false }), `${probe.file} does not exist`);
      });

      // Skip remaining checks for a missing file rather than throwing an unhelpful ENOENT
      // out of every subsequent test in this block.
      if (!statSync(filePath, { throwIfNoEntry: false })) {
        return;
      }

      const source = readFileSync(filePath, 'utf8');

      test('declared parameters exactly match parameters referenced in the file', () => {
        const declared = new Set(probe.parameters.map((p) => p.name));
        const referenced = extractParameterNames(source);

        const missingFromFile = [...declared].filter((n) => !referenced.has(n));
        const undeclaredInManifest = [...referenced].filter((n) => !declared.has(n));

        assert.deepEqual(
          missingFromFile,
          [],
          `manifest declares ${JSON.stringify(missingFromFile)} but file never references them`,
        );
        assert.deepEqual(
          undeclaredInManifest,
          [],
          `file references ${JSON.stringify(undeclaredInManifest)} but manifest does not declare them`,
        );
      });

      test('contains no forbidden mutating/dynamic-SQL tokens', () => {
        const hits = findForbiddenTokens(source);
        assert.deepEqual(hits, [], `forbidden tokens found: ${hits.join(', ')}`);
      });

      test('has a static SELECT/CTE result path (plus only safe SET statements)', () => {
        const result = hasSelectResultPath(source);
        assert.ok(result.ok, result.reason);
      });

      test('declares safe session settings (NOCOUNT, DEADLOCK_PRIORITY LOW, bounded LOCK_TIMEOUT)', () => {
        const stripped = stripSqlComments(source);
        assert.match(stripped, /SET\s+NOCOUNT\s+ON/i, 'missing SET NOCOUNT ON');
        assert.match(stripped, /SET\s+DEADLOCK_PRIORITY\s+LOW/i, 'missing SET DEADLOCK_PRIORITY LOW');
        assert.match(stripped, /SET\s+LOCK_TIMEOUT\s+\d+/i, 'missing bounded SET LOCK_TIMEOUT <ms>');
      });

      test('does not default to READ UNCOMMITTED / NOLOCK without explicit justification', () => {
        const stripped = stripSqlComments(source);
        const usesReadUncommitted = /READ\s+UNCOMMITTED|\bNOLOCK\b/i.test(stripped);
        if (usesReadUncommitted) {
          // If a probe ever does need it, the *file itself* (not just the manifest) must say why.
          assert.match(
            source,
            /READ UNCOMMITTED|NOLOCK/i,
            `${probe.file} uses relaxed isolation without an inline justification comment`,
          );
          assert.match(
            source,
            /because|since|safe to read dirty|acceptable/i,
            `${probe.file} uses relaxed isolation but its comment does not document why it is acceptable`,
          );
        }
      });

      test('result set count matches manifest resultSets (top-level SELECT/WITH statements)', () => {
        const statements = splitStatements(source);
        const selectLikeCount = statements.filter((s) => /^\s*(SELECT|WITH)\b/i.test(s)).length;
        assert.equal(
          selectLikeCount,
          probe.resultSets,
          `manifest says resultSets=${probe.resultSets} but file has ${selectLikeCount} SELECT/WITH statements`,
        );
      });

      test('does not eagerly fetch plan XML via sys.dm_exec_query_plan', () => {
        assert.doesNotMatch(
          stripSqlComments(source),
          /dm_exec_query_plan/i,
          `${probe.file} calls sys.dm_exec_query_plan; per design this catalog never fetches plan XML eagerly`,
        );
      });

      if (Object.prototype.hasOwnProperty.call(probe, 'versionVariantOf')) {
        test('version-variant file header states its version/platform applicability', () => {
          const headerText = source.slice(0, 1200);
          assert.match(
            headerText,
            /SQL Server 20\d\d|SQL2\d\d\d|2022\+|2019\+|2016\+|2017\+/,
            `${probe.file} is a version variant but its header does not state an explicit version/platform`,
          );
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. No orphan .sql files: every file under sql/probes/ is referenced by exactly one probe.
// ---------------------------------------------------------------------------

test('every .sql file under sql/probes/ is referenced by exactly one manifest probe', () => {
  const probesDir = path.join(sqlDir, 'probes');
  const allFiles = listSqlFilesRecursive(probesDir).map((f) => path.relative(sqlDir, f).split(path.sep).join('/'));
  const manifestFiles = new Set(manifest.probes.map((p) => p.file));

  const orphans = allFiles.filter((f) => !manifestFiles.has(f));
  assert.deepEqual(orphans, [], `orphan .sql files not referenced by manifest.json: ${orphans.join(', ')}`);

  const missing = [...manifestFiles].filter((f) => !allFiles.includes(f));
  assert.deepEqual(missing, [], `manifest references files that do not exist: ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 5. Targeted regression tests for defects found in review. Each test pins the exact fact that
//    was wrong, not just a generic shape/token check, so the specific defect cannot silently
//    reappear.
// ---------------------------------------------------------------------------

function probeById(id) {
  const probe = manifest.probes.find((p) => p.id === id);
  assert.ok(probe, `manifest is missing probe '${id}'`);
  return probe;
}

function readProbeSource(probe) {
  return readFileSync(path.join(sqlDir, probe.file), 'utf8');
}

const readmePath = path.join(sqlDir, 'README.md');
const readmeText = readFileSync(readmePath, 'utf8');

describe('regression: index.usage_summary requires VIEW SERVER (PERFORMANCE) STATE', () => {
  test('manifest.requiredPermission documents VIEW SERVER STATE / VIEW SERVER PERFORMANCE STATE', () => {
    const probe = probeById('index.usage_summary');
    assert.match(
      probe.requiredPermission,
      /VIEW SERVER STATE/,
      'manifest must not claim sys.dm_db_index_usage_stats needs no special permission',
    );
    assert.match(probe.requiredPermission, /VIEW SERVER PERFORMANCE STATE/);
    assert.doesNotMatch(probe.requiredPermission, /^None beyond ordinary/i);
  });

  test('probe file header documents VIEW SERVER STATE / VIEW SERVER PERFORMANCE STATE, not "no special permission"', () => {
    const probe = probeById('index.usage_summary');
    const source = readProbeSource(probe);
    const header = source.slice(0, 1500);
    assert.match(header, /VIEW SERVER STATE/);
    assert.match(header, /VIEW SERVER PERFORMANCE STATE/);
    assert.doesNotMatch(
      header,
      /no special permission beyond ordinary/i,
      'header must not claim this DMV needs no special permission',
    );
  });

  test('README permission table documents VIEW SERVER STATE / VIEW SERVER PERFORMANCE STATE for sys.dm_db_index_usage_stats', () => {
    const tableRow = readmeText
      .split('\n')
      .find((line) => line.includes('sys.dm_db_index_usage_stats') && line.includes('|'));
    assert.ok(tableRow, 'README permission table is missing a sys.dm_db_index_usage_stats row');
    assert.match(tableRow, /VIEW SERVER STATE/);
    assert.match(tableRow, /VIEW SERVER PERFORMANCE STATE/);
  });
});

describe('regression: index.operational_stats permission, reset semantics, and NULL fail-safe', () => {
  test('manifest.requiredPermission documents CONTROL on the specified object', () => {
    const probe = probeById('index.operational_stats');
    assert.match(probe.requiredPermission, /\bCONTROL\b/, 'manifest must document CONTROL permission');
    assert.doesNotMatch(probe.requiredPermission, /^None beyond ordinary/i);
  });

  test('manifest resultContract describes metadata-cache-driven resets, not just restart/rebuild', () => {
    const probe = probeById('index.operational_stats');
    assert.match(probe.resultContract, /metadata.cache/i);
    assert.doesNotMatch(
      probe.resultContract,
      /^Zero or more rows, one per \(object_id, index_id, partition_number\)\. Wait columns are milliseconds; count columns are raw counts\. Cumulative since the last engine restart or index rebuild, whichever is more recent\.$/,
      'resultContract still uses the old, inaccurate "since last restart or rebuild" wording verbatim',
    );
  });

  test('probe file guards @ObjectId with COALESCE(..., -1) so NULL cannot become a wildcard scan', () => {
    const probe = probeById('index.operational_stats');
    const source = readProbeSource(probe);
    assert.match(
      source,
      /sys\.dm_db_index_operational_stats\(\s*DB_ID\(\)\s*,\s*COALESCE\(\s*@ObjectId\s*,\s*-1\s*\)/i,
      'the TVF call must wrap @ObjectId in COALESCE(@ObjectId, -1) so a NULL parameter cannot trigger full-database enumeration',
    );
  });

  test('probe file header explains why 0 is not a safe NULL sentinel', () => {
    const probe = probeById('index.operational_stats');
    const source = readProbeSource(probe);
    assert.match(
      source,
      /object_id = 0.*(wildcard|NOT a safe sentinel)|NOT a safe sentinel.*object_id/is,
      'header must document that 0 is also wildcard-equivalent, not just NULL',
    );
  });

  test('probe file header no longer claims counters reset only "since last restart or rebuild"', () => {
    const probe = probeById('index.operational_stats');
    const source = readProbeSource(probe);
    const header = source.slice(0, 3200);
    assert.match(header, /metadata.cache/i);
    assert.doesNotMatch(
      header,
      /cumulative since the last engine restart or the index's last rebuild, whichever is more recent/i,
    );
  });
});

describe('regression: query_store_plan_summary version split (2016 vs 2017 vs 2022)', () => {
  test('the 2016 variant never selects plan_forcing_type (SQL Server 2017+ only column)', () => {
    const probe = probeById('querystore.plan_summary_2016');
    const source = readProbeSource(probe);
    assert.doesNotMatch(
      stripSqlComments(source),
      /plan_forcing_type/i,
      'querystore.plan_summary_2016 must not select plan_forcing_type/plan_forcing_type_desc: those columns ' +
        'do not exist on SQL Server 2016 and raise Invalid column name, not NULL',
    );
  });

  test('a 2017 variant exists and selects plan_forcing_type but not the 2022-only PSP columns', () => {
    const probe = probeById('querystore.plan_summary_2017');
    const source = readProbeSource(probe);
    const stripped = stripSqlComments(source);
    assert.match(stripped, /plan_forcing_type/i);
    assert.doesNotMatch(stripped, /has_compile_replay_script|is_optimized_plan_forcing_disabled|plan_type_desc/i);
  });

  test('the 2022 variant still carries the 2022-only parameter-sensitive-plan columns', () => {
    const probe = probeById('querystore.plan_summary_2022');
    const source = readProbeSource(probe);
    assert.match(stripSqlComments(source), /plan_type_desc/i);
  });

  test('manifest declares all three plan_summary variants chained via versionVariantOf', () => {
    for (const id of ['querystore.plan_summary_2016', 'querystore.plan_summary_2017', 'querystore.plan_summary_2022']) {
      const probe = probeById(id);
      assert.equal(probe.versionVariantOf, 'querystore.plan_summary', `probe '${id}'`);
    }
  });
});

describe('regression: query_store_runtime_stats_summary version split (2016 vs 2022 replica_group_id)', () => {
  test('the 2016 variant never selects replica_group_id (SQL Server 2022+ only column)', () => {
    const probe = probeById('querystore.runtime_stats_summary_2016');
    const source = readProbeSource(probe);
    assert.doesNotMatch(
      stripSqlComments(source),
      /replica_group_id/i,
      'querystore.runtime_stats_summary_2016 must not select replica_group_id: that column does not exist ' +
        'before SQL Server 2022 and raises Invalid column name',
    );
  });

  test('the 2022 variant selects AND groups by replica_group_id', () => {
    const probe = probeById('querystore.runtime_stats_summary_2022');
    const source = readProbeSource(probe);
    const stripped = stripSqlComments(source);
    assert.match(stripped, /rs\.replica_group_id/i);
    const groupByMatch = stripped.match(/GROUP BY([\s\S]+?);/i);
    assert.ok(groupByMatch, 'expected a GROUP BY clause');
    assert.match(groupByMatch[1], /replica_group_id/i, 'GROUP BY must include replica_group_id');
  });

  test('manifest declares both runtime_stats_summary variants chained via versionVariantOf', () => {
    for (const id of ['querystore.runtime_stats_summary_2016', 'querystore.runtime_stats_summary_2022']) {
      const probe = probeById(id);
      assert.equal(probe.versionVariantOf, 'querystore.runtime_stats_summary', `probe '${id}'`);
    }
  });
});

describe('regression: atlas workload summaries preserve fractional Query Store averages', () => {
  for (const id of [
    'querystore.database_workload_summary_2016',
    'querystore.database_workload_summary_2022',
  ]) {
    test(`${id}: multiplies as float and converts only final integral totals`, () => {
      const stripped = stripSqlComments(readProbeSource(probeById(id)));
      for (const [source, total] of [
        ['avg_duration', 'total_duration_us'],
        ['avg_cpu_time', 'total_cpu_us'],
        ['avg_logical_io_reads', 'logical_reads_pages'],
      ]) {
        assert.match(
          stripped,
          new RegExp(
            `SUM\\(\\s*CONVERT\\(\\s*float\\s*,\\s*rs\\.${source}\\s*\\)\\s*\\*\\s*` +
            'CONVERT\\(\\s*float\\s*,\\s*rs\\.count_executions\\s*\\)\\s*\\)',
            'i',
          ),
          `${id} must preserve the source float average through multiplication and summation`,
        );
        assert.match(
          stripped,
          new RegExp(
            `CONVERT\\(\\s*decimal\\(\\s*38\\s*,\\s*0\\s*\\)\\s*,\\s*` +
            `ROUND\\(\\s*SUM\\(\\s*${total}\\s*\\)\\s*,\\s*0\\s*\\)\\s*\\)`,
            'i',
          ),
          `${id} must round and checked-convert ${total} only after the final sum`,
        );
      }
      assert.doesNotMatch(
        stripped,
        /CONVERT\(\s*decimal\(\s*38\s*,\s*0\s*\)\s*,\s*rs\.avg_(?:duration|cpu_time|logical_io_reads)/i,
        `${id} must not round a fractional average before weighting it by executions`,
      );
    });
  }
});

describe('regression: query_store_wait_stats_summary replica grouping and division truncation', () => {
  test('2022 exec_agg CTE groups by replica_group_id and the outer join keys on it', () => {
    const probe = probeById('querystore.wait_stats_summary_2022');
    const source = readProbeSource(probe);
    const stripped = stripSqlComments(source);

    const execAggMatch = stripped.match(/exec_agg AS \(([\s\S]+?)\)\s*(?:,|SELECT)/i);
    assert.ok(execAggMatch, 'expected an exec_agg CTE');
    assert.match(
      execAggMatch[1],
      /GROUP BY[\s\S]*replica_group_id/i,
      'exec_agg must GROUP BY replica_group_id, otherwise one replica-agnostic execution total is ' +
        'applied to every per-replica wait row',
    );

    assert.match(
      stripped,
      /ea\.replica_group_id\s*=\s*wa\.replica_group_id/i,
      'the join from wait_agg to exec_agg must include replica_group_id as a join key',
    );
  });

  describe('regression: Query Store runtime weighted averages preserve fractional source values', () => {
    for (const id of ['querystore.runtime_page_2016', 'querystore.runtime_page_2022']) {
      test(`${id}: weights in float before the final aggregate`, () => {
        const source = stripSqlComments(readProbeSource(probeById(id)));
        assert.match(source, /CONVERT\(\s*float\s*,\s*rs\.avg_duration\s*\)/i);
        assert.match(source, /CONVERT\(\s*float\s*,\s*rs\.count_executions\s*\)/i);
        assert.doesNotMatch(
          source,
          /CONVERT\(\s*decimal\(38,\s*6\)\s*,\s*rs\.avg_duration\s*\)\s*\*/i,
          'decimal(38,6) multiplication can overflow before aggregation',
        );
      });
    }
  });

  for (const id of ['querystore.wait_stats_summary_2017', 'querystore.wait_stats_summary_2022']) {
    test(`${id}: weighted-average-per-execution expression casts to decimal/float before dividing`, () => {
      const probe = probeById(id);
      const source = readProbeSource(probe);
      const stripped = stripSqlComments(source);
      assert.match(
        stripped,
        /CAST\(\s*wa\.total_query_wait_time_ms\s+AS\s+(?:DECIMAL\(\s*\d+\s*,\s*\d+\s*\)|FLOAT(?:\(\d+\))?)\s*\)\s*\/\s*NULLIF\(\s*ea\.total_count_executions/i,
        `${id} must CAST the bigint numerator to a decimal/float type before dividing by ` +
          'total_count_executions, otherwise T-SQL performs bigint/bigint integer division and truncates ' +
          'the per-execution average',
      );
    });
  }
});

// Issue #81 part 1. These probes aggregate a CTE over @StartTime..@EndTime and then page through
// the result with a keyset cursor. Measured on a seeded instance: with the cursor predicate applied
// *outside* the CTE, logical reads stayed flat at 899 from the first page to the last while CPU
// fell, because every page re-aggregated the whole window -- the optimizer does not push the
// predicate below the aggregate on its own, so cost was O(window) per page rather than O(page).
// The predicate must therefore be applied to the base table before GROUP BY. That is safe only
// because every cursor column is also a grouping column, so the predicate is constant across each
// group and can never split one -- which is what keeps the active interval's flushed and in-memory
// duplicate rows summed together and not double-counted.
describe('regression: Query Store keyset pages filter before the aggregate, not after it', () => {
  const pagedProbes = [
    {
      id: 'querystore.runtime_page_2016',
      alias: 'rs',
      cursorColumns: ['runtime_stats_interval_id', 'plan_id', 'execution_type'],
    },
    {
      id: 'querystore.runtime_page_2022',
      alias: 'rs',
      cursorColumns: ['runtime_stats_interval_id', 'plan_id', 'execution_type', 'replica_group_id'],
    },
    {
      id: 'querystore.waits_page_2017',
      alias: 'ws',
      cursorColumns: ['runtime_stats_interval_id', 'plan_id', 'execution_type', 'wait_category'],
    },
    {
      id: 'querystore.waits_page_2022',
      alias: 'ws',
      cursorColumns: [
        'runtime_stats_interval_id',
        'plan_id',
        'execution_type',
        'replica_group_id',
        'wait_category',
      ],
    },
  ];

  // Everything from the CTE's opening `WITH ... AS (` to the matching close paren, so an assertion
  // about "inside the aggregate" cannot accidentally be satisfied by the outer SELECT and vice
  // versa. Counting parens rather than regex-matching the block is what makes that split reliable.
  function splitCteAndOuter(source) {
    const stripped = stripSqlComments(source);
    const open = stripped.indexOf('(', stripped.search(/\bWITH\s+buckets\s+AS\b/i));
    assert.ok(open > 0, 'expected a `WITH buckets AS (` common table expression');
    let depth = 0;
    let close = -1;
    for (let i = open; i < stripped.length; i += 1) {
      if (stripped[i] === '(') depth += 1;
      else if (stripped[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    assert.ok(close > open, 'the buckets CTE has unbalanced parentheses');
    return { cte: stripped.slice(open + 1, close), outer: stripped.slice(close + 1) };
  }

  for (const { id, alias, cursorColumns } of pagedProbes) {
    describe(id, () => {
      const source = readProbeSource(probeById(id));

      test('every @After* cursor parameter is referenced inside the aggregating CTE', () => {
        const { cte } = splitCteAndOuter(source);
        for (const name of extractParameterNames(source)) {
          if (!name.startsWith('@After')) continue;
          assert.ok(
            cte.includes(name),
            `${name} is not referenced inside the buckets CTE, so the page filter runs after the ` +
              'aggregate and every page re-aggregates the whole window (issue #81 part 1)',
          );
        }
      });

      test('no cursor predicate survives outside the CTE', () => {
        const { outer } = splitCteAndOuter(source);
        assert.doesNotMatch(
          outer,
          /@After/i,
          'a cursor predicate outside the CTE re-introduces the O(window)-per-page cost this ' +
            'rewrite removed; the outer SELECT must be TOP + ORDER BY only',
        );
        assert.doesNotMatch(
          outer,
          /\bWHERE\b/i,
          'the outer SELECT must not filter at all -- filtering there is what forced the full ' +
            'window through the aggregate on every page',
        );
      });

      test('the cursor predicate is applied to the base table, qualified by its alias', () => {
        const { cte } = splitCteAndOuter(source);
        for (const column of cursorColumns) {
          assert.match(
            cte,
            new RegExp(`\\b${alias}\\.${column}\\b`, 'i'),
            `the in-CTE cursor predicate must reference ${alias}.${column} on the base table so the ` +
              'engine can filter rows before grouping them',
          );
        }
      });

      test('every cursor column is also a grouping column, so the predicate cannot split a group', () => {
        const { cte } = splitCteAndOuter(source);
        const groupBy = cte.slice(cte.search(/\bGROUP\s+BY\b/i));
        assert.ok(groupBy.length > 0, 'expected a GROUP BY inside the buckets CTE');
        for (const column of cursorColumns) {
          assert.match(
            groupBy,
            new RegExp(`\\b${column}\\b`, 'i'),
            `${column} is a cursor column but not a grouping column. Filtering on it before ` +
              'GROUP BY would then drop part of a group rather than the whole group, splitting the ' +
              "active interval's duplicate rows and corrupting the aggregate",
          );
        }
      });

      test('the window bounds still use overlap semantics alongside the cursor predicate', () => {
        const { cte } = splitCteAndOuter(source);
        assert.match(
          cte,
          /rsi\.end_time\s*>\s*@StartTime/i,
          'adding the cursor predicate must not disturb the overlap window bound',
        );
        assert.match(cte, /rsi\.start_time\s*<\s*@EndTime/i);
      });
    });
  }
});

describe('regression: server.identity does not overclaim Azure SQL DB capacity from host DMVs', () => {
  test('probe header does not claim cpu_count/physical_memory_kb reflect the assigned vCore/DTU tier', () => {
    const probe = probeById('server.identity');
    const source = readProbeSource(probe);
    assert.doesNotMatch(
      source,
      /reflect the\s*\n?\s*--?\s*assigned vCore\/DTU tier/i,
      'sys.dm_os_sys_info cpu_count/physical_memory_kb may reflect the host/elastic-pool machine on ' +
        'Azure SQL Database, not the tenant capacity -- this claim must not appear',
    );
    assert.match(
      source,
      /host(ing)? the database or elastic pool|dm_user_db_resource_governance/i,
      'probe header must point at the host-machine caveat and/or the correct tenant-capacity DMVs',
    );
  });

  test('probe header cites the correct tenant-capacity sources', () => {
    const probe = probeById('server.identity');
    const source = readProbeSource(probe);
    assert.match(source, /dm_user_db_resource_governance/i);
    assert.match(source, /dm_os_job_object/i);
  });

  test('README Azure scope section states host-reported values do NOT reflect tenant capacity', () => {
    assert.doesNotMatch(
      readmeText,
      /cpu_count\s*\/\s*physical_memory_kb reflect the assigned vCore\/DTU tier/i,
      'the old false claim (without a "do not") must not reappear verbatim',
    );
    assert.match(
      readmeText,
      /do\s*\n?\s*not reflect the tenant's assigned vCore\/DTU capacity/i,
      'README must explicitly state these host-level columns are not a tenant-capacity indicator',
    );
    assert.match(readmeText, /dm_user_db_resource_governance/i);
    assert.match(readmeText, /dm_os_job_object/i);
  });
});

describe('server.identity_current remains a low-privilege database probe', () => {
  test('uses only SERVERPROPERTY and the current sys.databases row', () => {
    const probe = probeById('server.identity_current');
    const source = stripSqlComments(readProbeSource(probe));
    assert.equal(probe.connectionScope, 'database');
    assert.match(probe.requiredPermission, /ordinary access/i);
    assert.match(source, /SERVERPROPERTY\(\s*'ProductMajorVersion'\s*\)/i);
    assert.match(source, /SERVERPROPERTY\(\s*'EngineEdition'\s*\)/i);
    assert.match(source, /compatibility_level/i);
    assert.match(source, /database_id\s*=\s*DB_ID\(\)/i);
    assert.doesNotMatch(source, /dm_os_|dm_server_/i);
  });
});

describe('regression: server.database_discovery on Azure SQL DB is nuanced, not blanket unsupported', () => {
  test('manifest no longer flags database_discovery unsupported on Azure SQL Database', () => {
    const probe = probeById('server.database_discovery');
    assert.equal(probe.azureSqlDatabase.unsupported, false);
    assert.match(probe.azureSqlDatabase.notes, /connection context|master/i);
  });

  describe('regression: active request rows retain an idle session database', () => {
    test('uses the session database when no request row exists', () => {
      const source = stripSqlComments(readProbeSource(probeById('sessions.active_requests')));
      assert.match(source, /COALESCE\(\s*r\.database_id\s*,\s*s\.database_id\s*\)\s+AS\s+database_id/i);
      assert.match(source, /DB_NAME\(\s*COALESCE\(\s*r\.database_id\s*,\s*s\.database_id\s*\)\s*\)/i);
      assert.match(
        source,
        /@DatabaseId\s+IS\s+NULL\s+OR\s+COALESCE\(\s*r\.database_id\s*,\s*s\.database_id\s*\)\s*=\s*@DatabaseId/i,
      );
    });
  });

  // Issue #79. Sampling asks for idle sessions on purpose, so this probe returns rows that are not
  // requests at all. request_status has to arrive NULL for them and stay NULL, because a consumer
  // counting rows with a non-null status as running requests would otherwise report a mostly-idle
  // connection pool as concurrency.
  describe('regression: an idle session reports no request status', () => {
    test('request_status is projected straight from the requests DMV, never coalesced to a literal', () => {
      const source = stripSqlComments(readProbeSource(probeById('sessions.active_requests')));
      assert.match(
        source,
        /\br\.status\s+AS\s+request_status/i,
        'request_status must come directly from sys.dm_exec_requests.status so it is NULL for an ' +
          'idle session that has no request row',
      );
      assert.doesNotMatch(
        source,
        /(?:COALESCE|ISNULL)\s*\([^)]*\br\.status\b[^)]*\)\s+AS\s+request_status/i,
        'request_status must not be defaulted to a literal: substituting a synthetic status makes ' +
          'an idle session indistinguishable from a request in some state (issue #79)',
      );
      assert.doesNotMatch(
        source,
        /'idle'\s+AS\s+request_status/i,
        "the probe must never emit a synthetic 'idle' request status",
      );
    });

    test('the idle session row is still kept by the WHERE clause when idle sessions are requested', () => {
      const source = stripSqlComments(readProbeSource(probeById('sessions.active_requests')));
      assert.match(
        source,
        /@IncludeIdleSessions\s*=\s*1\s+OR\s+r\.session_id\s+IS\s+NULL|@IncludeIdleSessions\s*=\s*1\s+OR\s+r\.session_id\s+IS\s+NOT\s+NULL/i,
        'idle sessions must be included only when asked for, via the LEFT JOIN miss',
      );
    });

    test('manifest result contract states that an idle row carries a NULL request_status', () => {
      const probe = probeById('sessions.active_requests');
      assert.match(
        probe.resultContract,
        /NULL\s+request_status/i,
        'the published result contract must say an idle row has a NULL request_status, so a ' +
          'consumer knows null means "no request" rather than "state unknown"',
      );
      assert.match(
        probe.resultContract,
        /synthetic status|must not be replaced/i,
        'the result contract must forbid substituting a synthetic status for a NULL request_status',
      );
    });
  });

  test('only the documented, platform-limited probes are flagged unsupported on Azure SQL Database', () => {
    // Azure-unsupported is legitimate only for probes that call a DMV/catalog view Microsoft's own
    // documentation does not list as available on Azure SQL Database (sys.master_files,
    // sys.dm_os_host_info), or that require tempdb as the current database while Azure SQL
    // Database does not permit a tempdb connection. The session/task allocation DMVs in
    // tempdb.usage are explicitly documented as applicable only to tempdb, so a user-database
    // query is not a supported substitute. Unsupported is not a catch-all escape hatch, and this
    // test pins the exact allow-list so a future edit cannot silently widen it.
    const allowedUnsupported = new Set(['io.file_io_stats', 'server.host_info', 'tempdb.usage']);
    const stillUnsupported = manifest.probes.filter((p) => p.azureSqlDatabase.unsupported === true);
    for (const probe of stillUnsupported) {
      assert.ok(
        allowedUnsupported.has(probe.id),
        `probe '${probe.id}' is flagged unsupported on Azure SQL Database but is not on the ` +
          'documented allow-list (io.file_io_stats: sys.master_files; server.host_info: ' +
          'sys.dm_os_host_info; tempdb.usage: tempdb-only connection scope) -- verify against ' +
          'Microsoft Learn before adding it there',
      );
    }
    assert.deepEqual(
      stillUnsupported.map((p) => p.id).sort(),
      [...allowedUnsupported].sort(),
      'the set of Azure-unsupported probes drifted from the documented allow-list',
    );
  });
});

describe('regression: Microsoft Learn URLs use the canonical DMV doc path', () => {
  test('README contains no legacy /system-dynamic-management-views/ links', () => {
    assert.doesNotMatch(
      readmeText,
      /system-dynamic-management-views/,
      'DMV doc links must use the canonical /system-dynamic-management-objects/ path',
    );
  });

  test('every learn.microsoft.com URL in README uses a recognized, non-legacy path segment', () => {
    const urls = [...readmeText.matchAll(/https:\/\/learn\.microsoft\.com\S+(?=[)\s])/g)].map((m) => m[0]);
    assert.ok(urls.length > 0, 'expected at least one Microsoft Learn citation in README');
    for (const url of urls) {
      assert.doesNotMatch(url, /system-dynamic-management-views/, url);
    }
  });
});

describe('regression: sys.database_query_store_options zero-row claim is not overstated', () => {
  test('README does not claim the view returns zero rows when Query Store was never enabled', () => {
    assert.doesNotMatch(
      readmeText,
      /returning\s+\*{0,2}zero rows\*{0,2}\s+means Query Store has\s*\n?\s*never been enabled/i,
      'this exact claim is not supported by Microsoft documentation and must not appear',
    );
  });

  test('README treats actual_state/actual_state_desc as the authoritative enabled/disabled signal', () => {
    assert.match(readmeText, /actual_state_desc\s*=\s*'OFF'/i);
  });
});

// ---------------------------------------------------------------------------
// 6. Regression tests for the third review round (11 additional defects).
// ---------------------------------------------------------------------------

describe('regression: scheduler.pressure is split into a 2016 base and a 2019+ variant', () => {
  test('manifest declares scheduler.pressure_2016 and scheduler.pressure_2019 as version variants', () => {
    for (const id of ['scheduler.pressure_2016', 'scheduler.pressure_2019']) {
      const probe = probeById(id);
      assert.equal(probe.versionVariantOf, 'scheduler.pressure', `probe '${id}'`);
    }
  });

  test('the 2016 variant never selects ideal_workers_limit (SQL Server 2019+ only column)', () => {
    const probe = probeById('scheduler.pressure_2016');
    const source = readProbeSource(probe);
    assert.doesNotMatch(
      stripSqlComments(source),
      /ideal_workers_limit/i,
      'scheduler.pressure_2016 must not select ideal_workers_limit: that column does not exist ' +
        'before SQL Server 2019 and raises Invalid column name, not NULL',
    );
  });

  test('the 2019 variant selects ideal_workers_limit', () => {
    const probe = probeById('scheduler.pressure_2019');
    const source = readProbeSource(probe);
    assert.match(stripSqlComments(source), /sch\.ideal_workers_limit/i);
  });
});

describe('regression: Azure SQL Database platform-availability corrections', () => {
  test('server.identity no longer joins sys.dm_os_host_info and remains Azure-supported', () => {
    const probe = probeById('server.identity');
    const source = readProbeSource(probe);
    assert.doesNotMatch(
      stripSqlComments(source),
      /dm_os_host_info/i,
      'server.identity must not depend on sys.dm_os_host_info: that DMV is not available on ' +
        'Azure SQL Database and would break this otherwise cross-platform probe',
    );
    assert.equal(probe.azureSqlDatabase.unsupported, false);
  });

  test('server.host_info exists, carries sys.dm_os_host_info, and is flagged Azure-unsupported', () => {
    const probe = probeById('server.host_info');
    const source = readProbeSource(probe);
    assert.match(stripSqlComments(source), /dm_os_host_info/i);
    assert.equal(probe.azureSqlDatabase.unsupported, true);
    assert.match(probe.azureSqlDatabase.notes, /dm_os_host_info/i);
  });

  test('io.file_io_stats is flagged Azure-unsupported because it joins sys.master_files', () => {
    const probe = probeById('io.file_io_stats');
    const source = readProbeSource(probe);
    assert.match(stripSqlComments(source), /sys\.master_files/i);
    assert.equal(probe.azureSqlDatabase.unsupported, true);
    assert.match(probe.azureSqlDatabase.notes, /sys\.master_files/i);
  });

  test('io.file_io_stats_current_db is the Azure-safe variant, bounded to DB_ID() and sys.database_files', () => {
    const probe = probeById('io.file_io_stats_current_db');
    const source = readProbeSource(probe);
    const stripped = stripSqlComments(source);
    assert.match(stripped, /dm_io_virtual_file_stats\(\s*DB_ID\(\)/i);
    assert.match(stripped, /sys\.database_files/i);
    assert.doesNotMatch(stripped, /sys\.master_files/i);
    assert.equal(probe.azureSqlDatabase.unsupported, false);
  });

  test('README no longer claims every probe is blanket-supported on Azure SQL Database', () => {
    assert.doesNotMatch(
      readmeText,
      /No probe in this catalog is flagged blanket-`unsupported`/,
      'README must acknowledge io.file_io_stats and server.host_info as legitimately unsupported',
    );
    assert.match(readmeText, /io\.file_io_stats.*NOT SUPPORTED on Azure SQL Database/is);
    assert.match(readmeText, /server\.host_info.*NOT SUPPORTED on Azure SQL Database/is);
  });
});

describe('regression: sys.dm_db_file_space_usage / sys.dm_db_log_space_usage require server-level permission', () => {
  for (const id of ['space.database_file_space', 'space.log_space_usage']) {
    test(`${id}: manifest requires VIEW SERVER STATE / VIEW SERVER PERFORMANCE STATE, not VIEW DATABASE (PERFORMANCE) STATE`, () => {
      const probe = probeById(id);
      assert.match(probe.requiredPermission, /VIEW SERVER STATE/);
      assert.match(probe.requiredPermission, /VIEW SERVER PERFORMANCE STATE/);
      assert.doesNotMatch(probe.requiredPermission, /VIEW DATABASE PERFORMANCE STATE/);
    });

    test(`${id}: probe file header requires VIEW SERVER STATE / VIEW SERVER PERFORMANCE STATE`, () => {
      const probe = probeById(id);
      const header = readProbeSource(probe).slice(0, 2000);
      assert.match(header, /VIEW SERVER STATE/);
      assert.match(header, /VIEW SERVER PERFORMANCE STATE/);
    });
  }

  test('README permission table requires VIEW SERVER STATE for sys.dm_db_file_space_usage/sys.dm_db_log_space_usage', () => {
    assert.doesNotMatch(
      readmeText,
      /\|\s*`sys\.dm_db_file_space_usage`,\s*`sys\.dm_db_log_space_usage`\s*\|\s*`VIEW DATABASE STATE`/,
      'the old, incorrect VIEW DATABASE STATE row must not remain',
    );
    assert.match(
      readmeText,
      /sys\.dm_db_file_space_usage.*sys\.dm_db_log_space_usage.*VIEW SERVER STATE.*VIEW SERVER PERFORMANCE STATE/is,
    );
  });
});

describe('regression: Query Store options zero-row claim removed from probe files and manifest', () => {
  for (const id of ['querystore.options_2016', 'querystore.options_2019']) {
    test(`${id}: probe file no longer claims zero rows means Query Store was never enabled`, () => {
      const probe = probeById(id);
      const source = readProbeSource(probe);
      assert.doesNotMatch(source, /zero rows if Query Store was never enabled/i);
      assert.match(source, /actual_state/i);
    });

    test(`${id}: manifest resultContract no longer claims zero rows means Query Store was never enabled`, () => {
      const probe = probeById(id);
      assert.doesNotMatch(probe.resultContract, /zero rows if Query Store was never enabled/i);
      assert.match(probe.resultContract, /actual_state/i);
    });
  }
});

describe('regression: sessions.memory_grants NULL contract for grant_time vs. wait_time_ms', () => {
  test('probe header documents grant_time IS NULL as the waiting signal, not the wait_time_ms pairing', () => {
    const probe = probeById('sessions.memory_grants');
    const source = readProbeSource(probe);
    assert.match(source, /grant_time IS NULL/i);
    assert.doesNotMatch(
      source,
      /grant_time\/wait_time_ms are NULL until the grant is actually issued/i,
      'the old, incorrect claim that both columns share one NULL-until-granted story must not remain',
    );
  });

  test('probe header documents wait_time_ms as NULL once granted (the opposite timing of grant_time)', () => {
    const probe = probeById('sessions.memory_grants');
    const source = readProbeSource(probe);
    assert.match(source, /wait_time_ms.*NULL if the memory is already granted|NULL.*once granted/is);
  });

  test('manifest resultContract states the grant_time / wait_time_ms inverse-null relationship', () => {
    const probe = probeById('sessions.memory_grants');
    assert.match(probe.resultContract, /grant_time IS NULL/i);
    assert.match(probe.resultContract, /inverse/i);
  });
});

describe('regression: sessions.blocking_inputs deduplicates idle-transaction facts under MARS', () => {
  test('probe file aggregates sys.dm_tran_session_transactions to one row per session_id before joining', () => {
    const probe = probeById('sessions.blocking_inputs');
    const source = readProbeSource(probe);
    const stripped = stripSqlComments(source);
    assert.match(
      stripped,
      /MAX\(\s*tst\.open_transaction_count\s*\)[\s\S]*?GROUP BY\s+tst\.session_id/i,
      'must pre-aggregate sys.dm_tran_session_transactions with MAX(open_transaction_count) ' +
        'GROUP BY session_id so a MARS session cannot emit more than one idle_open_transaction row',
    );
  });

  test('manifest resultContract documents the MARS dedup', () => {
    const probe = probeById('sessions.blocking_inputs');
    assert.match(probe.resultContract, /MARS/i);
  });
});

describe('regression: sample_ms is computer uptime, not Database Engine restart', () => {
  for (const id of ['io.file_io_stats', 'io.file_io_stats_current_db']) {
    test(`${id}: probe header attributes sample_ms to computer (OS) uptime, not engine restart`, () => {
      const probe = probeById(id);
      const source = readProbeSource(probe);
      assert.match(source, /sample_ms.*(computer|OS).*start/is);
      assert.match(source, /sqlserver_start_time/i);
    });
  }

  test('README Timestamps section attributes sample_ms to computer uptime', () => {
    assert.match(readmeText, /sample_ms.*computer \(operating system\) was started/is);
    assert.doesNotMatch(
      readmeText,
      /sample_ms.*milliseconds since the Database Engine's last restart/is,
      'the old, incorrect claim must not remain',
    );
  });

  test('README Reset semantics section recommends sqlserver_start_time or counter regression, not sample_ms alone', () => {
    assert.match(readmeText, /sqlserver_start_time.*not\s+`?sample_ms`?/is);
  });
});

describe('regression: index.usage_summary reset semantics do not claim rebuild resets counters', () => {
  test('probe file no longer claims a reset on index rebuild', () => {
    const probe = probeById('index.usage_summary');
    const source = readProbeSource(probe);
    assert.doesNotMatch(
      source,
      /cumulative since the last engine restart or (the )?index('s)? (last )?rebuild/i,
      'no official documentation attributes a counter reset to rebuilding an index',
    );
    assert.match(source, /detach(ed)? or (is )?shut down|AUTO_CLOSE/i);
  });

  test('manifest resultContract no longer claims a reset on index rebuild', () => {
    const probe = probeById('index.usage_summary');
    assert.doesNotMatch(
      probe.resultContract,
      /since the last engine restart or index rebuild/i,
      'no official documentation attributes a counter reset to rebuilding an index',
    );
  });

  test('README no longer attributes an index-usage-stats reset to rebuilding an index', () => {
    assert.doesNotMatch(
      readmeText,
      /index's last rebuild\/creation, whichever is more recent/i,
      'the old, unsupported rebuild-reset claim must not remain',
    );
    assert.doesNotMatch(
      readmeText,
      /has not been touched by\s*\n?\s*a compiled plan since the engine last restarted \(or since the index was last\s*\n?\s*rebuilt\/created\)/i,
    );
  });
});

describe('regression: Query Store wait-stats CTEs are bounded by @StartTime/@EndTime before aggregation', () => {
  for (const id of ['querystore.wait_stats_summary_2017', 'querystore.wait_stats_summary_2022']) {
    test(`${id}: wait_agg CTE joins the interval table and filters by the time window before GROUP BY`, () => {
      const probe = probeById(id);
      const source = readProbeSource(probe);
      const stripped = stripSqlComments(source);
      const waitAggMatch = stripped.match(/wait_agg AS \(([\s\S]+?)\)\s*,\s*exec_agg/i);
      assert.ok(waitAggMatch, `${id}: expected a wait_agg CTE followed by exec_agg`);
      assert.match(
        waitAggMatch[1],
        /JOIN\s+sys\.query_store_runtime_stats_interval[\s\S]*WHERE[\s\S]*@StartTime[\s\S]*@EndTime[\s\S]*GROUP BY/i,
        `${id}: wait_agg must join sys.query_store_runtime_stats_interval and filter by ` +
          '@StartTime/@EndTime BEFORE its own GROUP BY, so aggregation never touches rows ' +
          'outside the requested window',
      );
    });

    test(`${id}: exec_agg CTE joins the interval table and filters by the time window before GROUP BY`, () => {
      const probe = probeById(id);
      const source = readProbeSource(probe);
      const stripped = stripSqlComments(source);
      const execAggMatch = stripped.match(/exec_agg AS \(([\s\S]+?)\)\s*SELECT/i);
      assert.ok(execAggMatch, `${id}: expected an exec_agg CTE followed by the final SELECT`);
      assert.match(
        execAggMatch[1],
        /JOIN\s+sys\.query_store_runtime_stats_interval[\s\S]*WHERE[\s\S]*@StartTime[\s\S]*@EndTime[\s\S]*GROUP BY/i,
        `${id}: exec_agg must join sys.query_store_runtime_stats_interval and filter by ` +
          '@StartTime/@EndTime BEFORE its own GROUP BY',
      );
    });
  }
});

describe('regression: Query Store window summaries use overlap bounds, not start-only bounds', () => {
  // runtime_stats_summary, wait_stats_summary, and database_workload_summary all aggregate the same
  // sys.query_store_runtime_stats over a window. They must select every interval that OVERLAPS the
  // window (rsi.end_time > @StartTime AND rsi.start_time < @EndTime) so the atlas database-wide
  // workload totals reconcile with the per-plan drill-down. A start-only lower bound
  // (rsi.start_time >= @StartTime) silently drops the interval straddling @StartTime and undercounts.
  for (const id of [
    'querystore.runtime_stats_summary_2016',
    'querystore.runtime_stats_summary_2022',
    'querystore.database_workload_summary_2016',
    'querystore.database_workload_summary_2022',
  ]) {
    test(`${id}: bounds the interval join with end_time > @StartTime and start_time < @EndTime`, () => {
      const stripped = stripSqlComments(readProbeSource(probeById(id)));
      assert.match(
        stripped,
        /rsi\.end_time\s*>\s*@StartTime/i,
        `${id}: lower bound must be rsi.end_time > @StartTime (overlap), not a start-only bound`,
      );
      assert.match(
        stripped,
        /rsi\.start_time\s*<\s*@EndTime/i,
        `${id}: upper bound must be rsi.start_time < @EndTime`,
      );
      assert.doesNotMatch(
        stripped,
        /rsi\.start_time\s*>=?\s*@StartTime/i,
        `${id}: must not use a start_time lower bound; that drops the interval straddling @StartTime`,
      );
    });
  }
});

describe('regression: read-only guard rejects SELECT ... INTO across the whole probe catalog', () => {
  test('no probe file in sql/probes/ contains a SELECT ... INTO shape', () => {
    for (const probe of manifest.probes) {
      const source = readProbeSource(probe);
      const hits = findForbiddenTokens(source);
      assert.ok(
        !hits.includes('SELECT INTO (creates a table)'),
        `${probe.file} must not contain a SELECT ... INTO shape`,
      );
    }
  });
});

// Every column an executor reads by name must actually be emitted by the probe SQL corpus.
// This is deliberately corpus-wide rather than per-probe: it needs no mapping from a C#
// call site to a probe id, so it cannot drift, yet it still catches the failure mode that
// motivated it -- SqlLiveIncidentProbeExecutor read "total_log_size_mb"/"used_log_space_mb"
// while space/log_space_usage.sql emits "total_log_size_bytes"/"used_log_space_bytes",
// throwing IndexOutOfRangeException on every connected sampling cycle. The unit tests could
// not catch it because they all substitute a fake executor for the real SqlDataReader path.
describe('probe executors only read columns the probe SQL emits', () => {
  const executorPaths = [
    'src/SqlSimCity.Collection/Probes/SqlLiveIncidentProbeExecutor.cs',
    'src/SqlSimCity.Collection/Atlas/SqlClientAtlasProbeExecutor.cs',
  ];

  const allProbeSql = listSqlFilesRecursive(path.join(sqlDir, 'probes'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
    .toLowerCase();

  for (const relative of executorPaths) {
    test(`${relative}: every reader["column"] exists in the probe SQL`, () => {
      const source = readFileSync(path.join(repoRoot, relative), 'utf8');
      const columns = new Set();
      for (const match of source.matchAll(/reader\[\s*"([a-z0-9_]+)"\s*\]/gi)) {
        columns.add(match[1].toLowerCase());
      }

      assert.ok(columns.size > 0, 'expected to find at least one reader["column"] access');

      const missing = [...columns].filter((c) => !allProbeSql.includes(c)).sort();
      assert.deepEqual(
        missing,
        [],
        `these columns are read in C# but appear in no probe SQL file: ${missing.join(', ')}`,
      );
    });
  }
});

describe('regression: by-name column readers never use CommandBehavior.SequentialAccess', () => {
  // SequentialAccess lets each column be read once, in ascending ordinal order,
  // and throws InvalidOperationException otherwise. Reading by name gives no
  // hint of the underlying ordinal, so the constraint is invisible at the call
  // site and breaks only against a live server. SqlQueryStoreIncrementalSource
  // shipped with SequentialAccess and read is_query_store_on (ordinal 8) before
  // database_name (ordinal 1) in database discovery, so connected Query Store
  // history threw on the first cycle and never collected a single row.
  function listCsFilesRecursive(dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        results.push(...listCsFilesRecursive(full));
      } else if (entry.endsWith('.cs')) {
        results.push(full);
      }
    }
    return results;
  }

  const collectionDir = path.join(repoRoot, 'src/SqlSimCity.Collection');
  const offenders = [];
  for (const file of listCsFilesRecursive(collectionDir)) {
    // Strip comments first: the fix itself is documented in prose that names
    // the behavior, and a naive substring scan would flag that explanation.
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');
    if (/reader\[\s*"/.test(source) && source.includes('CommandBehavior.SequentialAccess')) {
      offenders.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
    }
  }

  test('no file reads columns by name under SequentialAccess', () => {
    assert.deepEqual(
      offenders.sort(),
      [],
      'these files read reader["column"] while using CommandBehavior.SequentialAccess, ' +
        'which requires ascending-ordinal single reads and will throw at runtime: ' +
        offenders.join(', '),
    );
  });
});
