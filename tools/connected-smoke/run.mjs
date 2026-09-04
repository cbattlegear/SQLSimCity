#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
export const ownerLabel = 'io.sqlsimcity.connected-smoke';
export const sqlImage = 'mcr.microsoft.com/mssql/server:2022-latest';
export const database = 'SmokeCity';

export function parseArgs(args) {
  const options = { keep: false, noBrowser: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--image', '--out', '--keep', '--no-browser'].includes(key) || seen.has(key))
      throw new Error('Usage: node tools/connected-smoke/run.mjs --image <image> --out <directory> [--keep] [--no-browser]');
    seen.add(key);
    if (key === '--keep') options.keep = true;
    else if (key === '--no-browser') options.noBrowser = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`${key} needs a value.`);
      options[key.slice(2)] = value;
    }
  }
  if (!options.image || !options.out) throw new Error('--image and --out are required.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(options.image))
    throw new Error('--image must be a Docker image reference.');
  options.out = resolve(options.out);
  return options;
}

export function resourceNames(runId = randomBytes(16).toString('hex')) {
  if (!/^[a-f0-9]{32}$/.test(runId)) throw new Error('Invalid run identity.');
  const prefix = `sqlsimcity-smoke-${runId}`;
  return { runId, network: `${prefix}-net`, sql: `${prefix}-sql`, api: `${prefix}-api` };
}

export function redact(text, secrets) {
  let safe = text;
  for (const secret of secrets) safe = safe.split(secret).join('[redacted]');
  return safe.replace(/((?:password|pwd)\s*=\s*)[^;\r\n]*/gi, '$1[redacted]');
}

// Capture output, never echo argv, stdin, environment, or raw command failures.
export function command(executable, args, { env = {}, input = '', timeout = 120_000, signal } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '', timedOut = false, inputError = null;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    const cancel = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-1_048_576); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-1_048_576); });
    child.stdin.on('error', error => { inputError = error; });
    child.stdin.end(input);
    child.on('error', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new Error(`Could not start ${executable === process.execPath ? 'Node' : executable}.`));
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (inputError && code === 0) reject(new Error('Command exited before its input was delivered.', { cause: inputError }));
      else resolveResult({ code, stdout, stderr, timedOut, signal: exitSignal });
    });
  });
}

export function dockerClient(runCommand = command) {
  return async (args, options) => {
    const result = await runCommand('docker', args, options);
    if (result.code !== 0) {
      const error = new Error(`Docker ${args[0]} ${result.timedOut ? 'timed out' : 'failed'} (exit ${result.code ?? result.signal}).`);
      error.dockerStderr = result.stderr;
      throw error;
    }
    return result.stdout.trim();
  };
}

export async function cleanupRig(names, docker) {
  const failures = [];
  for (const [kind, name] of [['container', names.api], ['container', names.sql], ['network', names.network]]) {
    try {
      // A failed/interrupted create may have succeeded in the daemon. Look up ONLY the planned
      // name, verify its unguessable ownership label, then remove by ID (not a recyclable name).
      const ids = await docker([kind === 'container' ? 'ps' : 'network',
        ...(kind === 'container' ? ['-aq', '--no-trunc'] : ['ls', '-q', '--no-trunc']),
        '--filter', `name=${name}`, '--filter', `label=${ownerLabel}=${names.runId}`]);
      for (const id of ids.split(/\s+/).filter(Boolean)) {
        const inspected = await docker([kind, 'inspect', '--format',
          kind === 'container'
            ? '{{json .Config.Labels}}|{{.Name}}|{{.Id}}'
            : '{{json .Labels}}|{{.Name}}|{{.Id}}', id]);
        const [labels, actualName, actualId] = inspected.split('|');
        if (actualName.replace(/^\//, '') !== name || JSON.parse(labels)?.[ownerLabel] !== names.runId || actualId !== id)
          throw new Error('Ownership verification failed.');
        await docker(kind === 'container' ? ['rm', '--force', '--volumes', id] : ['network', 'rm', id]);
      }
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`Cleanup incomplete; inspect only these owned resources: ${failures.join(', ')}`);
}

export function browserInvocation(origin, out) {
  return [resolve(root, 'tools', 'measure-browser', 'smoke.js'), '--origin', origin,
    '--database', database, '--out', out];
}

async function waitFor(description, probe, signal, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      signal.throwIfAborted();
      lastError = error;
    }
    await delay(1_000, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${description}.${lastError ? ` Last failure: ${lastError.message}` : ''}`,
    { cause: lastError });
}

export function parseVerification(output) {
  const match = output.match(/^SMOKE_VERIFIED (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)\s*$/m);
  if (!match) throw new Error('Collector verification did not return its success marker.');
  const [tables, rows, parameterizedQueries, multiTableQueries, executions, projectionQueries] = match.slice(1).map(Number);
  if (tables !== 12 || rows < 6000 || parameterizedQueries < 163 || multiTableQueries < 139 || executions < 12905 || projectionQueries < 128)
    throw new Error('Collector verification returned insufficient workload.');
  return { login: 'smoke_collector', deniedWrite: true, administrativeRoles: false,
    queryCaptureMode: 'ALL', tables, rows, parameterizedQueries, multiTableQueries, executions, projectionQueries };
}

export function queryStoreContinuation(first, second) {
  if (first?.items?.length !== 100 || !first.nextPageToken || !second?.items?.length) return null;
  const items = [...first.items, ...second.items];
  const families = new Set(items.map(item => item.familyId));
  const projectionFamilies = new Set(items.filter(item =>
    /\bsmoke_projection_\d+\b/i.test(item.text?.normalizedText ?? '')).map(item => item.familyId));
  if (families.size !== items.length || families.size < 128) return null;
  return { firstPageFamilies: first.items.length, continuationFamilies: second.items.length,
    distinctFamilies: families.size, projectionFamilies: projectionFamilies.size };
}

export async function runRig(options, dependencies = {}) {
  const docker = dependencies.docker ?? dockerClient();
  const runCommand = dependencies.command ?? command;
  const checkBrowser = dependencies.checkBrowser ?? (() => stat(browserInvocation('', '')[0]));
  const fetchJson = dependencies.fetchJson ?? (async url => {
    const response = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
    if (!response.ok) return null;
    return response.json();
  });
  const names = dependencies.names ?? resourceNames();
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    controller.abort(new Error('Interrupted; cleaning up the isolated rig.'));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const secrets = [`Ssc!${randomBytes(24).toString('hex')}Aa1`, `Ssc!${randomBytes(24).toString('hex')}Bb2`];
  let stage = 'preflight', ready = null, failure = null, ownsOutput = false;
  const result = { schemaVersion: 1, runId: names.runId, outcome: 'failed', stage, retained: false, cleanup: 'pending' };
  const save = (file, value) => writeFile(resolve(options.out, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const sql = (text, collector = false) => docker(['exec', '-i', '--env', 'SQLCMDPASSWORD', names.sql,
    '/opt/mssql-tools18/bin/sqlcmd', '-S', 'localhost', '-U', collector ? 'smoke_collector' : 'sa',
    '-d', collector ? database : 'master', '-C', '-b', '-V', '16', '-r', '1', '-h', '-1', '-W', '-l', '5', '-t', '90'],
  { input: text, env: { SQLCMDPASSWORD: secrets[collector ? 1 : 0] } });
  try {
    await mkdir(options.out, { recursive: true });
    // Exclusive sentinel: never overwrite another run's handoff or diagnostics.
    await save('run.json', { schemaVersion: 1, ...names, database,
      cleanupCommand: `node tools/connected-smoke/cleanup.mjs --run-id ${names.runId}` });
    ownsOutput = true;
    await docker(['version', '--format', '{{.Server.Version}}']);
    await docker(['image', 'inspect', '--format', '{{.Id}}', options.image]);
    if (!options.noBrowser) await checkBrowser();
    controller.signal.throwIfAborted();
    stage = 'create-network';
    await docker(['network', 'create', '--driver', 'bridge', '--label', `${ownerLabel}=${names.runId}`, names.network]);
    controller.signal.throwIfAborted();
    stage = 'start-sql';
    await docker(['create', '--name', names.sql, '--hostname', names.sql, '--network', names.network,
      '--label', `${ownerLabel}=${names.runId}`, '--env', 'ACCEPT_EULA=Y', '--env', 'MSSQL_PID=Developer',
      '--env', 'MSSQL_MEMORY_LIMIT_MB=2048', '--env', 'MSSQL_SA_PASSWORD', sqlImage],
    { env: { MSSQL_SA_PASSWORD: secrets[0] }, timeout: 300_000 });
    controller.signal.throwIfAborted();
    await docker(['start', names.sql]);
    stage = 'wait-sql';
    await waitFor('SQL Server', () => sql('SET NOCOUNT ON; SELECT 1;\nGO\n'), controller.signal);
    stage = 'seed-sql';
    const seed = (await readFile(resolve(here, 'seed.sql'), 'utf8')).replace('__COLLECTOR_PASSWORD__', secrets[1]);
    await sql(seed);
    stage = 'verify-collector';
    const verification = parseVerification(await sql(await readFile(resolve(here, 'verify.sql'), 'utf8'), true));
    result.verification = verification;
    controller.signal.throwIfAborted();
    stage = 'start-api';
    const connection = `Server=${names.sql},1433;Database=${database};User ID=smoke_collector;Password=${secrets[1]};Encrypt=True;TrustServerCertificate=True;Connect Timeout=10;Application Name=ConnectedSmokeCollector`;
    await docker(['create', '--name', names.api, '--network', names.network,
      '--label', `${ownerLabel}=${names.runId}`, '--publish', '127.0.0.1::8080',
      '--env', 'ConnectionStrings__SqlSimCity',
      '--env', 'ASPNETCORE_HTTP_PORTS=8080',
      '--env', 'Atlas__TargetId=connected-smoke',
      '--env', 'Atlas__DisplayName=Disposable connected smoke',
      '--env', `Atlas__KnownDatabases__0=${database}`,
      '--env', 'Atlas__RefreshIntervalSeconds=10',
      '--env', 'Atlas__QueryStoreRefreshIntervalSeconds=10',
      '--env', `QueryStoreHistory__KnownDatabases__0=${database}`,
      options.image], { env: { ConnectionStrings__SqlSimCity: connection } });
    controller.signal.throwIfAborted();
    await docker(['start', names.api]);
    const ports = JSON.parse(await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', names.api]));
    const bindings = ports['8080/tcp'];
    if (bindings?.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || !/^\d+$/.test(bindings[0].HostPort))
      throw new Error(`API must have exactly one loopback port binding; observed ${JSON.stringify(ports)}.`);
    const origin = `http://127.0.0.1:${bindings[0].HostPort}`;
    stage = 'wait-api-city';
    const city = await waitFor('collected SmokeCity objects and query families', async () => {
      const summaries = await fetchJson(`${origin}/api/v1/database-city`);
      const summary = summaries?.databases?.find(item => item.name === database);
      if (!summary) return null;
      const page = await fetchJson(`${origin}/api/v1/database-city/${encodeURIComponent(summary.databaseId)}?pageSize=50`);
      return page?.databaseName === database && page.objects?.length >= 12 &&
        page.topQueryFamilies?.length > 0 &&
        page.routes?.some(route => route.kind === 'ObjectReference') &&
        page.objects.every(item => Number(item.reservedBytes) > 0) ? page : null;
    }, controller.signal);
    stage = 'wait-api-continuation';
    const apiVerification = await waitFor('128 distinct collected families across query continuation', async () => {
      // Query Store keys by the SQL database name; the city route uses the atlas-qualified ID.
      const url = `${origin}/api/v1/query-store/queries?databaseId=${encodeURIComponent(database)}&pageSize=100`;
      const first = await fetchJson(url);
      if (!first?.nextPageToken) return null;
      const second = await fetchJson(`${url}&pageToken=${encodeURIComponent(first.nextPageToken)}`);
      return queryStoreContinuation(first, second);
    }, controller.signal);
    result.apiVerification = apiVerification;
    ready = { schemaVersion: 1, ready: true, origin, database, databaseId: city.databaseId, queryStoreDatabaseId: database,
      resources: names, verification, apiVerification,
      cleanupCommand: `node tools/connected-smoke/cleanup.mjs --run-id ${names.runId}` };
    await save('readiness.json', ready);
    console.log(JSON.stringify(ready));
    if (!options.noBrowser) {
      stage = 'browser';
      const browser = await runCommand(process.execPath, browserInvocation(origin, options.out),
        { timeout: 300_000, signal: controller.signal });
      await writeFile(resolve(options.out, 'browser-process.log'),
        redact(browser.stdout + browser.stderr, secrets), { flag: 'wx' });
      if (browser.code !== 0) throw new Error(`Browser smoke failed (exit ${browser.code ?? browser.signal}).`);
    }
    controller.signal.throwIfAborted();
    result.outcome = 'passed';
  } catch (error) {
    failure = error;
    result.error = redact(error.message, secrets);
    if (error.dockerStderr) result.dockerError = redact(error.dockerStderr, secrets).slice(-4000);
    for (const name of ownsOutput ? [names.sql, names.api] : []) {
      try {
        const labels = JSON.parse(await docker(['inspect', '--format', '{{json .Config.Labels}}', name]));
        if (labels?.[ownerLabel] === names.runId) {
          const logs = await docker(['logs', '--tail', '150', name]);
          await writeFile(resolve(options.out, `${name === names.sql ? 'sql' : 'api'}.log`),
            redact(logs, secrets), { flag: 'wx' });
        }
      } catch (error) {
        // Diagnostics must not prevent cleanup, but their absence must remain visible.
        (result.diagnosticErrors ??= []).push(redact(`${name}: ${error.message}`, secrets));
      }
    }
  } finally {
    result.stage = stage;
    result.retained = options.keep && ready !== null && !interrupted;
    try {
      if (!result.retained) await cleanupRig(names, docker);
      result.cleanup = result.retained ? 'explicitly-retained' : 'completed';
    } catch (error) {
      result.outcome = 'failed';
      result.cleanup = 'incomplete';
      result.cleanupError = error.message;
      failure ??= error;
    }
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try { if (ownsOutput) await save('result.json', result); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  return { ready, result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runRig(parseArgs(process.argv.slice(2)));
  } catch (error) {
    // runRig writes a sanitized diagnostic; raw errors may include a rejected SQL batch.
    console.error(error.dockerStderr ? 'Connected smoke failed; see result.json.' : error.message);
    process.exitCode = 1;
  }
}
