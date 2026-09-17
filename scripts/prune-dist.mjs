import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)],
  );
}

for (const output of walk('dist')) {
  const name = relative('dist', output),
    source = name.endsWith('.js.map')
      ? join('src', name.slice(0, -7) + '.ts')
      : name.endsWith('.js')
        ? join('src', name.slice(0, -3) + '.ts')
        : null;
  if (source && !existsSync(source)) rmSync(output);
}
