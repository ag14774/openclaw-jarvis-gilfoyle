import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = dirname(fileURLToPath(import.meta.resolve('openclaw')));

async function loadNamed(prefix, name) {
  const matches = readdirSync(dist).filter(
    (name) => name.startsWith(prefix) && name.endsWith('.js'),
  );
  for (const file of matches) {
    const module = await import(pathToFileURL(join(dist, file)).href),
      value = Object.values(module).find(
        (candidate) => typeof candidate === 'function' && candidate.name === name,
      );
    if (value) return value;
  }
  assert.fail(`Pinned OpenClaw ${name} export not found`);
}

export async function loadWorkboardTestInternals() {
  const [WorkboardStore, sqliteStores] = await Promise.all([
    loadNamed('runtime-api-', 'WorkboardStore'),
    loadNamed('sqlite-store-', 'createWorkboardSqliteStores'),
  ]);
  return { WorkboardStore, sqliteStores };
}
