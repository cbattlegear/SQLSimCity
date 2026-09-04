#!/usr/bin/env node
import { cleanupRig, dockerClient, resourceNames } from './run.mjs';

try {
  const [flag, runId, ...extra] = process.argv.slice(2);
  if (flag !== '--run-id' || !runId || extra.length) throw new Error('Usage: node tools/connected-smoke/cleanup.mjs --run-id <32-character run ID>');
  await cleanupRig(resourceNames(runId), dockerClient());
  console.log(`Removed only connected-smoke resources owned by ${runId}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
