import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  browserInvocation, cleanupRig, database, ownerLabel, parseArgs, parseVerification,
  queryStoreContinuation, redact, resourceNames, runRig, sqlImage,
} from './run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const verified = 'SMOKE_VERIFIED 12 6240 163 139 12905 128';
const validArgs = ['--image', 'sqlsimcity-ci:test', '--out', 'artifacts'];

test('only accepts an application image, output directory, and explicit lifecycle switches', () => {
  assert.deepEqual(parseArgs([...validArgs, '--keep', '--no-browser']), {
    image: 'sqlsimcity-ci:test', out: resolve('artifacts'), keep: true, noBrowser: true,
  });
  for (const extra of [['--host', 'production'], ['--connection-string', 'secret'],
    ['--database', 'master'], ['--sql-image', 'other'], ['--keep', '--keep'],
    ['--image', 'duplicate'], ['--out'], ['--unknown']]) {
    assert.throws(() => parseArgs([...validArgs, ...extra]));
  }
  assert.throws(() => parseArgs(['--image', '--keep', '--out', 'artifacts']));
  assert.throws(() => parseArgs(['--image', 'image;command', '--out', 'artifacts']));
  assert.throws(() => parseArgs([]));
});

test('run IDs and all resource names are unique and non-reusable target input is rejected', () => {
  const first = resourceNames(), second = resourceNames();
  assert.match(first.runId, /^[0-9a-f]{32}$/);
  for (const name of ['sql', 'api', 'network']) assert.notEqual(first[name], second[name]);
  for (const bad of ['production', '', '0'.repeat(31), '0'.repeat(32) + ';'])
    assert.throws(() => resourceNames(bad));
});

test('verification requires actual parameterized, multi-table runtime evidence', () => {
  assert.equal(parseVerification(verified).deniedWrite, true);
  for (const invalid of ['', 'SMOKE_VERIFIED 12 6240 0 0 0 0', 'SMOKE_VERIFIED 12 6240 163 0 233 128',
    'SMOKE_VERIFIED 12 0 163 11 233 128', 'SMOKE_VERIFIED 12 6240 163 11 0 128',
    'SMOKE_VERIFIED 12 6240 163 139 12905 0', 'SMOKE_VERIFIED 12 6240 163 139 233 128',
    'SMOKE_VERIFIED 12 6240 163 11 12905 128'])
    assert.throws(() => parseVerification(invalid));
});

test('redacts known credentials and password fields without emitting the original', () => {
  assert.equal(redact('error abc-def;Password=abc-def; Pwd=other', ['abc-def']),
    'error [redacted];Password=[redacted]; Pwd=[redacted]');
});

function fakeDocker(names, { failStage, signal, collision = false } = {}) {
  const resources = new Map(), calls = [];
  let counter = 0;
  const docker = async (args, options = {}) => {
    calls.push({ args, options });
    const [op] = args;
    if (op === 'version') return '29.7.2';
    if (op === 'image') return 'sha256:application';
    if (op === 'network' && args[1] === 'create' || op === 'create') {
      const name = op === 'network' ? args.at(-1) : args[args.indexOf('--name') + 1];
      const id = (++counter).toString(16).padStart(64, '0');
      resources.set(id, { name, label: names.runId, kind: op === 'network' ? 'network' : 'container' });
      if (failStage === name) throw new Error('Daemon created resource but client lost response.');
      if (signal && name === names.sql) process.emit(signal);
      return id;
    }
    if (op === 'start') return args[1];
    if (op === 'exec') {
      if (options.input.includes('CREATE DATABASE')) return '';
      if (options.input.includes('SMOKE_VERIFIED')) return verified;
      return '1';
    }
    if (op === 'inspect' && args.includes('{{json .NetworkSettings.Ports}}'))
      return JSON.stringify({ '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '41234' }] });
    if (op === 'inspect') return JSON.stringify({ [ownerLabel]: names.runId });
    if (op === 'logs') return 'diagnostic';
    if (op === 'ps' || op === 'network' && args[1] === 'ls') {
      const name = args.find(arg => arg.startsWith('name=')).slice(5);
      assert.ok(args.includes(`label=${ownerLabel}=${names.runId}`));
      return [...resources].filter(([, item]) => item.name === name).map(([id]) => id).join('\n');
    }
    if (['container', 'network'].includes(op) && args[1] === 'inspect') {
      const id = args.at(-1), resource = resources.get(id);
      return `${JSON.stringify({ [ownerLabel]: collision ? 'different-owner' : resource.label })}|/${resource.name}|${id}`;
    }
    if (op === 'rm' || op === 'network' && args[1] === 'rm') {
      const id = args.at(-1);
      assert.match(id, /^[a-f0-9]{64}$/);
      resources.delete(id);
      return id;
    }
    throw new Error(`Unexpected fake Docker operation ${op}`);
  };
  return { docker, calls, resources };
}

function queryPages() {
  const items = Array.from({ length: 163 }, (_, index) => ({
    familyId: `family-${index}`, text: { normalizedText: index < 128
      ? `SELECT id AS smoke_projection_${index + 1} FROM commerce.entity_1` : 'SELECT other' },
  }));
  return [
    { items: items.slice(0, 100), nextPageToken: 'continuation' },
    { items: items.slice(100), nextPageToken: null },
  ];
}

test('API continuation must contain 128 genuinely distinct families and counts normalized projections', () => {
  const [first, second] = queryPages();
  assert.equal(queryStoreContinuation(first, second).projectionFamilies, 128);
  assert.equal(queryStoreContinuation(first, first), null);
  assert.equal(queryStoreContinuation(first, { items: [] }), null);
  assert.equal(queryStoreContinuation({ ...first, nextPageToken: null }, second), null);
  assert.equal(queryStoreContinuation(first, { ...second, items: second.items.slice(0, 27) }), null);
});

async function withRig(t, overrides = {}) {
  const names = resourceNames();
  const out = resolve(here, `.test-${randomBytes(8).toString('hex')}`);
  await mkdir(out);
  t.after(() => rm(out, { recursive: true, force: true }));
  const fake = fakeDocker(names, overrides);
  const options = { image: 'local:test', out, keep: false, noBrowser: true, ...overrides };
  const deps = {
    ...fake, names,
    fetchJson: async url => {
      if (url.includes('/query-store/queries')) {
        assert.equal(new URL(url).searchParams.get('databaseId'), database);
        return queryPages()[url.includes('pageToken=') ? 1 : 0];
      }
      return url.endsWith('/api/v1/database-city')
        ? { databases: [{ name: database, databaseId: 'smoke/database/SmokeCity' }] }
        : { databaseName: database, databaseId: 'smoke/database/SmokeCity',
          objects: Array.from({ length: 12 }, () => ({ reservedBytes: '8192' })), topQueryFamilies: [{}],
          routes: [{ kind: 'ObjectReference' }] };
    },
    command: async () => ({ code: 0, stdout: '', stderr: '' }),
    checkBrowser: async () => {},
  };
  return { fake, options, deps, names };
}

test('uses isolated Docker resources, in-memory credentials, and defaults to exact cleanup', async t => {
  const { fake, options, deps, names } = await withRig(t);
  const { ready, result } = await runRig(options, deps);
  assert.equal(ready.origin, 'http://127.0.0.1:41234');
  assert.equal(ready.database, database);
  assert.equal(result.retained, false);
  assert.equal(fake.resources.size, 0);
  const creates = fake.calls.filter(call => call.args[0] === 'create');
  assert.equal(creates.length, 2);
  const [sql, api] = creates;
  assert.equal(sql.args.at(-1), sqlImage);
  assert.ok(!sql.args.includes('--publish'));
  assert.ok(!sql.args.includes('--volume'));
  assert.equal(api.args.at(-1), options.image);
  assert.ok(api.args.includes('127.0.0.1::8080'));
  assert.ok(api.args.includes(names.network));
  assert.ok(fake.calls.some(call => call.args[0] === 'network' && call.args.includes('bridge')));
  assert.ok(!fake.calls.some(call => call.args.includes('host')));
  const connection = api.options.env.ConnectionStrings__SqlSimCity;
  assert.match(connection, /User ID=smoke_collector;/);
  assert.ok(!connection.includes('User ID=sa;'));
  const password = connection.match(/Password=([^;]+)/)[1];
  assert.ok(!JSON.stringify(fake.calls.map(call => call.args)).includes(password));
  for (const file of await readdir(options.out)) {
    const content = await readFile(resolve(options.out, file), 'utf8');
    assert.ok(!content.includes(password));
    assert.ok(!content.includes(sql.options.env.MSSQL_SA_PASSWORD));
  }
});

test('--keep --no-browser publishes handoff and cleanup is explicit, exact and idempotent', async t => {
  const { fake, options, deps, names } = await withRig(t, { keep: true });
  const { ready, result } = await runRig(options, deps);
  assert.equal(result.retained, true);
  assert.equal(fake.resources.size, 3);
  assert.ok(ready.cleanupCommand.endsWith(names.runId));
  assert.deepEqual(JSON.parse(await readFile(resolve(options.out, 'readiness.json'), 'utf8')), ready);
  await cleanupRig(names, fake.docker);
  await cleanupRig(names, fake.docker);
  assert.equal(fake.resources.size, 0);
});

test('an uncertain Docker create is recovered and cleaned up even with --keep', async t => {
  const rig = await withRig(t, { keep: true });
  const failed = fakeDocker(rig.names, { failStage: rig.names.sql });
  await assert.rejects(runRig(rig.options, { ...rig.deps, docker: failed.docker }), /lost response/);
  assert.equal(failed.resources.size, 0);
  assert.equal(JSON.parse(await readFile(resolve(rig.options.out, 'result.json'), 'utf8')).retained, false);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} cleans up partial resources, overriding --keep`, async t => {
    const { fake, options, deps } = await withRig(t, { keep: true, signal });
    await assert.rejects(runRig(options, deps), /Interrupted/);
    assert.equal(fake.resources.size, 0);
  });
}

test('cleanup refuses a same-named resource whose ownership label changed', async t => {
  const { fake, options, deps, names } = await withRig(t, { keep: true, collision: true });
  await runRig(options, deps);
  await assert.rejects(cleanupRig(names, fake.docker), /Cleanup incomplete/);
  assert.equal(fake.resources.size, 3);
  assert.ok(!fake.calls.some(call => call.args[0] === 'rm'));
});

test('browser handoff uses the existing stack and actual API origin, never fixture mode', () => {
  const args = browserInvocation('http://127.0.0.1:45678', resolve(here, 'output'));
  assert.equal(args[0], resolve(here, '..', 'measure-browser', 'smoke.js'));
  assert.deepEqual(args.slice(1), ['--origin', 'http://127.0.0.1:45678',
    '--database', 'SmokeCity', '--out', resolve(here, 'output')]);
});

test('a browser failure still cleans up and preserves useful credential-free diagnostics', async t => {
  const { fake, options, deps } = await withRig(t, { noBrowser: false });
  deps.command = async (executable, args) => {
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, browserInvocation('http://127.0.0.1:41234', options.out));
    const password = fake.calls.find(call => call.options.env?.ConnectionStrings__SqlSimCity)
      .options.env.ConnectionStrings__SqlSimCity.match(/Password=([^;]+)/)[1];
    return { code: 1, stdout: '', stderr: `Browser failed ${password}` };
  };
  await assert.rejects(runRig(options, deps), /Browser smoke failed/);
  assert.equal(fake.resources.size, 0);
  assert.equal(await readFile(resolve(options.out, 'browser-process.log'), 'utf8'), 'Browser failed [redacted]');
  const result = JSON.parse(await readFile(resolve(options.out, 'result.json'), 'utf8'));
  assert.equal(result.stage, 'browser');
  assert.equal(result.cleanup, 'completed');
});

test('a missing browser script fails before creating any resources', async t => {
  const { fake, options, deps } = await withRig(t, { noBrowser: false });
  deps.checkBrowser = async () => { throw new Error('Missing browser harness'); };
  await assert.rejects(runRig(options, deps), /Missing browser harness/);
  assert.equal(fake.resources.size, 0);
  assert.ok(!fake.calls.some(call => call.args[0] === 'create' || call.args.includes('create')));
});

test('reusing an active output directory never writes into the other run artifacts', async t => {
  const { fake, options, deps } = await withRig(t);
  await writeFile(resolve(options.out, 'run.json'), '{"owner":"another run"}\n');
  await assert.rejects(runRig(options, deps), /EEXIST/);
  assert.deepEqual(await readdir(options.out), ['run.json']);
  assert.equal(await readFile(resolve(options.out, 'run.json'), 'utf8'), '{"owner":"another run"}\n');
  assert.equal(fake.resources.size, 0);
});
